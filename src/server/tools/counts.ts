import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { dateText, inr, qty, UOM_LONG, UOM_SHORT } from '@/lib/format';
import { ToolError } from '../errors';
import { defineTool } from './define';
import { flag, opt, optNum } from './helpers';
import { notify, ownerIds } from './notifications';
import { nextNumber } from './numbers';
import type { Db, Tx } from './types';

// ── words and small helpers ────────────────────────────────────────────────────────────────────────
const REASONS = ['SPILLAGE', 'EXTRA_WASTAGE', 'MISSING', 'ENTRY_ERROR', 'UNEXPLAINED'] as const;
type Reason = (typeof REASONS)[number];
export const REASON_TEXT: Record<Reason, string> = { SPILLAGE: 'Spillage', EXTRA_WASTAGE: 'Extra wastage', MISSING: 'Missing', ENTRY_ERROR: 'Entry error', UNEXPLAINED: "Don't know" };
const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'] as const;
const STATUS_TEXT: Record<(typeof STATUSES)[number], string> = { DRAFT: 'In progress', PENDING_APPROVAL: 'With the owner', APPROVED: 'Approved', REJECTED: 'Sent back' };
const OPEN = ['DRAFT', 'REJECTED', 'PENDING_APPROVAL'] as const;
/** Pieces, rolls and sets are counted whole; kg, metres and litres take decimals. */
const WHOLE_UNITS = new Set(['NOS', 'ROLL', 'SET']);
const MAX_ROWS = 500;

const num = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d));
const dec = (x: number | string | Prisma.Decimal) => new Prisma.Decimal(x);
const kindText = (c: { isOpening: boolean }) => (c.isOpening ? 'Opening count' : 'Stock count');
const signed = (n: number, uom: string) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${qty(Math.abs(n), uom)}`;
const names = (list: string[], max = 6) => (list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and ${list.length - max} more`);

/** Today in India, as YYYY-MM-DD. */
export const todayIST = (now = new Date()) => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const validYmd = (s: string) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const dateReq = (what: string) => z.string({ required_error: `Choose the ${what}.`, invalid_type_error: `Choose the ${what}.` }).refine(validYmd, `That is not a real date. Choose the ${what}.`);
const dateOpt = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().refine(validYmd, 'That is not a real date.').optional());
const emptyToUndef = (v: unknown) => (v === '' || v === null ? undefined : v);
const countId = z.preprocess(emptyToUndef, z.string().min(1).max(64).optional());

type Count = Prisma.StockCountGetPayload<object>;
type Line = Prisma.StockCountLineGetPayload<{ include: { material: { select: { name: true; uom: true } } } }>;
const withMaterial = { material: { select: { name: true, uom: true } } } as const;

// ── looking things up ──────────────────────────────────────────────────────────────────────────────
/** There is only ever one count open at a time (draft, sent back, or with the owner). */
export const openCount = (db: Db) => db.stockCount.findFirst({ where: { status: { in: [...OPEN] } }, orderBy: { createdAt: 'asc' } });

async function resolveCount(db: Db, id: string | undefined, prefer?: Count['status']): Promise<Count> {
  if (id) {
    const c = await db.stockCount.findUnique({ where: { id } });
    if (!c) throw new ToolError('NOT_FOUND', "Couldn't find that count.", undefined, 'stockCountId');
    return c;
  }
  const c = (prefer && (await db.stockCount.findFirst({ where: { status: prefer }, orderBy: { createdAt: 'asc' } }))) || (await openCount(db));
  if (!c) throw new ToolError('NOT_FOUND', 'There is no count in progress.');
  return c;
}

function assertEditable(c: Count) {
  if (c.status === 'PENDING_APPROVAL') throw new ToolError('COUNT_LOCKED', `${c.number} is with the owner, so it can't be changed now. If it needs a fix, the owner can send it back.`);
  if (c.status === 'APPROVED') throw new ToolError('COUNT_LOCKED', `${c.number} is approved and final. A mistake is put right by the next count.`);
}

/** What is still missing on a line. Opening: quantity, and a rate for anything with stock. Normal: the quantity. */
function missingOf(isOpening: boolean, l: Pick<Line, 'countedQty' | 'unitRate'>): 'quantity and rate' | 'quantity' | 'rate' | null {
  const noQty = l.countedQty === null;
  if (!isOpening) return noQty ? 'quantity' : null;
  const needsRate = l.unitRate === null && (noQty || Number(l.countedQty) > 0);
  if (noQty && needsRate) return 'quantity and rate';
  if (noQty) return 'quantity';
  return needsRate ? 'rate' : null;
}

/** One line as a read tool returns it. The opening count has no System or Difference column. */
const toLine = (isOpening: boolean, l: Line) => {
  const counted = num(l.countedQty), rate = num(l.unitRate);
  return {
    id: l.id, materialId: l.materialId, material: l.material.name, unit: l.material.uom,
    systemQty: isOpening ? null : Number(l.systemQty), countedQty: counted, difference: isOpening ? null : num(l.differenceQty),
    reason: l.reasonCode, unitRate: rate, sourceInvoiceNo: l.sourceInvoiceNo, sourceInvoiceDate: l.sourceInvoiceDate ? l.sourceInvoiceDate.toISOString().slice(0, 10) : null,
    notes: l.notes, value: counted !== null && rate !== null ? Math.round(counted * rate * 100) / 100 : null, missing: missingOf(isOpening, l),
  };
};
export type CountLineRow = ReturnType<typeof toLine>;

const progressOf = (rows: { countedQty: number | null }[]) => ({ counted: rows.filter((r) => r.countedQty !== null).length, total: rows.length });

/** The numbers an approval or a "send to owner" needs: value for the opening count, differences for a normal one. */
export async function summarize(db: Db, c: Count) {
  const lines = await db.stockCountLine.findMany({ where: { stockCountId: c.id }, include: { material: { select: { name: true, uom: true } } }, orderBy: { material: { name: 'asc' } } });
  const balances = c.isOpening ? [] : await db.stockBalance.findMany({ where: { materialId: { in: lines.map((l) => l.materialId) } }, select: { materialId: true, averageRate: true } });
  const avg = new Map(balances.map((b) => [b.materialId, Number(b.averageRate)]));
  const counted = lines.filter((l) => l.countedQty !== null).length;
  let totalValue = 0, withStock = 0, short = 0, over = 0, differing = 0;
  const big: { material: string; unit: string; text: string; abs: number }[] = [];
  for (const l of lines) {
    const q = num(l.countedQty);
    if (c.isOpening) {
      if (q !== null && q > 0) { withStock++; totalValue += q * (num(l.unitRate) ?? 0); big.push({ material: l.material.name, unit: l.material.uom, abs: q * (num(l.unitRate) ?? 0), text: `${l.material.name}: ${qty(q, l.material.uom)} at ₹${(num(l.unitRate) ?? 0).toLocaleString('en-IN')} = ${inr(q * (num(l.unitRate) ?? 0))}` }); }
    } else {
      const d = num(l.differenceQty) ?? 0;
      if (q !== null && d !== 0) {
        differing++;
        const v = Math.abs(d) * (avg.get(l.materialId) ?? 0);
        if (d < 0) short += v; else over += v;
        big.push({ material: l.material.name, unit: l.material.uom, abs: v, text: `${l.material.name}: system ${qty(Number(l.systemQty), l.material.uom)}, counted ${qty(q, l.material.uom)} (${signed(d, l.material.uom)}, ${inr(v)})${l.reasonCode ? ` · ${REASON_TEXT[l.reasonCode as Reason]}` : ''}` });
      }
    }
  }
  big.sort((a, b) => b.abs - a.abs);
  totalValue = Math.round(totalValue * 100) / 100;
  const text = c.isOpening
    ? `${withStock} material${withStock === 1 ? '' : 's'} with stock, total value ${inr(totalValue)}.`
    : differing === 0 ? 'Every material matches the system.' : `${differing} material${differing === 1 ? ' differs' : 's differ'}: ${inr(short)} short${over > 0 ? `, ${inr(over)} over` : ''}.`;
  return { lines, counted, total: lines.length, totalValue, withStock, differing, short: Math.round(short * 100) / 100, over: Math.round(over * 100) / 100, biggest: big.slice(0, 3).map((b) => b.text), text };
}

// ── editing one line (shared by submit_count_line and the count sheet) ─────────────────────────────
interface Edit { countedQty?: number; reasonCode?: Reason; notes?: string; unitRate?: number; sourceInvoiceNo?: string; sourceInvoiceDate?: string }

async function applyEdit(db: Tx, count: Count, line: Line, e: Edit): Promise<Line> {
  const unit = line.material.uom;
  if (e.countedQty !== undefined && WHOLE_UNITS.has(unit) && !Number.isInteger(e.countedQty)) {
    throw new ToolError('INVALID_QUANTITY', `${line.material.name} is counted in whole ${UOM_LONG[unit] ?? 'units'}.`, undefined, 'countedQty');
  }
  if (count.isOpening) {
    if (e.unitRate !== undefined && !(e.unitRate > 0)) throw new ToolError('INVALID_RATE', "A rate of zero isn't allowed. Take the rate from the last purchase invoice.", undefined, 'unitRate');
  } else if (e.unitRate !== undefined || e.sourceInvoiceNo !== undefined || e.sourceInvoiceDate !== undefined) {
    throw new ToolError('RATE_NOT_ALLOWED', "A normal count doesn't take a rate. Differences are valued at the current average rate.", undefined, 'unitRate');
  }

  const data: Prisma.StockCountLineUpdateInput = {};
  const counted = e.countedQty ?? num(line.countedQty);
  if (e.countedQty !== undefined) data.countedQty = e.countedQty;
  if (counted !== null) {
    const diff = dec(counted).minus(line.systemQty);
    data.differenceQty = diff;
    if (!count.isOpening) {
      // A difference with no reason is stored as "don't know" at once, and never asked about again (BUSINESS_FLOW §11).
      data.reasonCode = diff.isZero() ? null : (e.reasonCode ?? (line.reasonCode as Reason | null) ?? 'UNEXPLAINED');
    }
  } else if (e.reasonCode && !count.isOpening) {
    throw new ToolError('COUNT_FIRST', 'Enter the counted quantity first.', undefined, 'countedQty');
  }
  if (e.notes !== undefined) data.notes = e.notes;
  if (count.isOpening) {
    if (e.unitRate !== undefined) data.unitRate = e.unitRate;
    if (e.sourceInvoiceNo !== undefined) data.sourceInvoiceNo = e.sourceInvoiceNo;
    if (e.sourceInvoiceDate !== undefined) data.sourceInvoiceDate = new Date(`${e.sourceInvoiceDate}T00:00:00Z`);
  }
  if (Object.keys(data).length === 0) throw new ToolError('NOTHING_TO_SAVE', 'Nothing to save. Fill in the counted quantity' + (count.isOpening ? ' or the rate.' : '.'), undefined, 'countedQty');
  return db.stockCountLine.update({ where: { id: line.id }, data, include: withMaterial });
}

const editShape = {
  countedQty: optNum('counted quantity', 0),
  reasonCode: z.preprocess(emptyToUndef, z.enum(REASONS, { errorMap: () => ({ message: 'Choose a reason from the list.' }) }).optional()),
  notes: opt(300),
  unitRate: optNum('rate', 0),
  sourceInvoiceNo: opt(60),
  sourceInvoiceDate: dateOpt,
};

// ── list_counts ────────────────────────────────────────────────────────────────────────────────────
export const listCounts = defineTool({
  name: 'list_counts', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ status: z.preprocess(emptyToUndef, z.enum(STATUSES).optional()) }),
  handler: async (ctx, input) => {
    const counts = await ctx.db.stockCount.findMany({ where: input.status ? { status: input.status } : {}, orderBy: { createdAt: 'desc' }, take: 50, include: { _count: { select: { lines: true } } } });
    const done = await ctx.db.stockCountLine.groupBy({ by: ['stockCountId'], where: { stockCountId: { in: counts.map((c) => c.id) }, countedQty: { not: null } }, _count: { _all: true } });
    const doneBy = new Map(done.map((d) => [d.stockCountId, d._count._all]));
    return {
      rows: counts.map((c) => ({
        id: c.id, number: c.number, date: c.countDate.toISOString(), type: kindText(c), status: c.status, statusText: STATUS_TEXT[c.status],
        counted: doneBy.get(c.id) ?? 0, total: c._count.lines, rejectionNote: c.rejectionNote,
      })),
    };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'n', label: 'Count' }, { key: 't', label: 'Type' }, { key: 'd', label: 'Date' }, { key: 's', label: 'Status' }, { key: 'p', label: 'Counted', align: 'right' }],
    rows: d.rows.slice(0, 10).map((r) => ({ n: r.number, t: r.type, d: dateText(new Date(r.date)), s: r.statusText, p: `${r.counted} of ${r.total}` })),
    note: d.rows.length === 0 ? 'No counts yet.' : d.rows.length > 10 ? `Showing 10 of ${d.rows.length}.` : undefined,
  }],
});

// ── list_count_lines ───────────────────────────────────────────────────────────────────────────────
export const listCountLines = defineTool({
  name: 'list_count_lines', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ stockCountId: countId, onlyUnfinished: flag.optional() }),
  handler: async (ctx, input) => {
    const c = await resolveCount(ctx.db, input.stockCountId);
    const lines = await ctx.db.stockCountLine.findMany({ where: { stockCountId: c.id }, include: withMaterial, orderBy: { material: { name: 'asc' } } });
    const all = lines.map((l) => toLine(c.isOpening, l));
    const rows = (input.onlyUnfinished ? all.filter((r) => r.missing) : all).slice(0, MAX_ROWS);
    return {
      count: { id: c.id, number: c.number, kind: kindText(c), isOpening: c.isOpening, status: c.status, statusText: STATUS_TEXT[c.status], date: c.countDate.toISOString(), rejectionNote: c.rejectionNote },
      ...progressOf(all), totalValue: c.isOpening ? Math.round(all.reduce((s, r) => s + (r.value ?? 0), 0) * 100) / 100 : null,
      rows, shown: rows.length,
    };
  },
  view: (d) => {
    const opening = d.count.isOpening;
    const cols = opening
      ? [{ key: 'm', label: 'Material' }, { key: 'c', label: 'Counted', align: 'right' as const }, { key: 'r', label: 'Rate', align: 'right' as const }, { key: 'n', label: 'Still needed' }]
      : [{ key: 'm', label: 'Material' }, { key: 's', label: 'System', align: 'right' as const }, { key: 'c', label: 'Counted', align: 'right' as const }, { key: 'd', label: 'Difference', align: 'right' as const }];
    const rows = d.rows.slice(0, 10).map((r): Record<string, string> => opening
      ? { m: r.material, c: r.countedQty === null ? '–' : qty(r.countedQty, r.unit), r: r.unitRate === null ? '–' : `₹${r.unitRate.toLocaleString('en-IN')}/${UOM_SHORT[r.unit] ?? ''}`, n: r.missing ?? '' }
      : { m: r.material, s: qty(r.systemQty ?? 0, r.unit), c: r.countedQty === null ? '–' : qty(r.countedQty, r.unit), d: r.difference === null ? '–' : r.difference === 0 ? '0' : signed(r.difference, r.unit) });
    return [{
      kind: 'table', title: `${d.count.number} · ${d.count.kind} · ${d.counted} of ${d.total} counted`, columns: cols, rows,
      note: d.rows.length > 10 ? `Showing 10 of ${d.rows.length}.` : d.rows.length === 0 ? 'Nothing is left to finish.' : undefined,
    }];
  },
});

// ── start_stock_count ──────────────────────────────────────────────────────────────────────────────
export const startStockCount = defineTool({
  name: 'start_stock_count', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ countDate: dateReq('count date'), isOpening: flag.optional(), materialIds: z.array(z.string().min(1).max(64)).max(500).optional() }),
  form: {
    title: 'Start a stock count', verb: 'Start count',
    fields: [
      { name: 'countDate', label: 'Date of the count', type: 'date', required: true },
      { name: 'isOpening', label: 'This is the opening count (go-live, done once)', type: 'checkbox', hint: 'Quantity and rate from the last purchase invoice for every material.' },
    ],
  },
  stamp: 'COUNT STARTED',
  describe: (a) => [
    String(a.number),
    `${a.kind} · ${a.materials} materials · ${a.date}`,
    a.isOpening ? 'Enter the quantity and the rate from the last purchase invoice for each material. The invoice number is optional. It can take several days.' : 'The system quantities are fixed as of now.',
  ],
  preview: async (ctx, input) => {
    const open = await openCount(ctx.db);
    if (open) {
      const done = await ctx.db.stockCountLine.count({ where: { stockCountId: open.id, countedQty: { not: null } } });
      const total = await ctx.db.stockCountLine.count({ where: { stockCountId: open.id } });
      return { info: [`${open.number} (${kindText(open).toLowerCase()}) is already open: ${done} of ${total} counted. Open the count sheet to continue it.`] };
    }
    const openingDone = (await ctx.db.stockCount.count({ where: { isOpening: true, status: 'APPROVED' } })) > 0;
    const values: Record<string, unknown> = { countDate: todayIST() };
    const info: string[] = [];
    if (!openingDone) {
      values.isOpening = true;
      info.push('The opening count has not been done yet. It comes first, and only once: quantity and rate from the last purchase invoice for every material.');
    }
    return { info, values: { ...values, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } };
  },
  handler: async (ctx, input) => {
    const isOpening = input.isOpening === true;
    if (input.countDate > todayIST(ctx.now)) throw new ToolError('INVALID_DATE', "A count can't be dated in the future.", undefined, 'countDate');
    const open = await openCount(ctx.db);
    const openingDone = (await ctx.db.stockCount.count({ where: { isOpening: true, status: 'APPROVED' } })) > 0;

    if (isOpening) {
      if (openingDone) throw new ToolError('OPENING_ALREADY_DONE', 'The opening count has already been done. From now on, use a normal stock count.');
      if (open?.isOpening) throw new ToolError('OPENING_IN_PROGRESS', `The opening count is already started (${open.number}). Continue it instead of starting another.`);
      if ((await ctx.db.stockMovement.count()) > 0) throw new ToolError('OPENING_NOT_FIRST', 'Stock has already been recorded, so an opening count would count it twice. The opening count has to come first.');
    } else {
      if (!openingDone) throw new ToolError('OPENING_NOT_DONE', open?.isOpening ? `The opening count (${open.number}) has to be finished and approved before a normal count.` : 'The opening count has to be done and approved first. Tick "This is the opening count".');
      if (open) throw new ToolError('COUNT_IN_PROGRESS', `${open.number} is still open. Finish it before starting another count.`);
    }

    const wanted = isOpening ? undefined : input.materialIds;
    const materials = await ctx.db.material.findMany({ where: { isActive: true, ...(wanted?.length ? { id: { in: wanted } } : {}) }, include: { balance: true }, orderBy: { name: 'asc' } });
    if (wanted?.length && materials.length !== new Set(wanted).size) throw new ToolError('NOT_FOUND', "One of those materials couldn't be found.");
    if (materials.length === 0) throw new ToolError('NO_MATERIALS', 'There are no materials to count yet. Add the materials first.');

    const countDate = new Date(`${input.countDate}T00:00:00+05:30`);
    const count = await ctx.db.stockCount.create({ data: { number: await nextNumber(ctx.db, 'CNT', countDate), countDate, isOpening, countedById: ctx.session.userId } });
    await ctx.db.stockCountLine.createMany({ data: materials.map((m) => ({ stockCountId: count.id, materialId: m.id, systemQty: isOpening ? 0 : (m.balance?.quantity ?? 0) })) });
    return {
      data: { id: count.id, number: count.number, kind: kindText(count), materials: materials.length, isOpening },
      audit: { entityType: 'StockCount', entityId: count.id, action: 'CREATE', after: { number: count.number, kind: kindText(count), isOpening, date: dateText(countDate), materials: materials.length } },
    };
  },
  followUps: async () => ({ facts: [], chips: [{ label: 'Open the count sheet', sheet: true as const }] }),
});

// ── submit_count_line ──────────────────────────────────────────────────────────────────────────────
const lineSummary = (a: Record<string, unknown>): string[] => {
  const unit = String(a.unit);
  const out = [String(a.material)];
  const counted = a.counted === null || a.counted === undefined ? null : Number(a.counted);
  if (a.isOpening) {
    out.push(counted === null ? 'Quantity still to count' : `Counted: ${qty(counted, unit)}`);
    if (a.rate) out.push(`Rate ₹${Number(a.rate).toLocaleString('en-IN')}/${UOM_SHORT[unit] ?? ''}${a.invoiceNo ? ` · invoice ${a.invoiceNo}` : ''}`);
    else if (counted === null || counted > 0) out.push('Rate still needed, from the last purchase invoice.');
  } else {
    out.push(counted === null ? 'Not counted yet' : `Counted: ${qty(counted, unit)} · System: ${qty(Number(a.system), unit)}`);
    if (a.difference) out.push(`Difference: ${signed(Number(a.difference), unit)}${a.reason ? ` · ${REASON_TEXT[a.reason as Reason]}` : ''}`);
  }
  out.push(`${a.done} of ${a.total} materials counted`);
  return out;
};

const afterLine = (c: Count, l: Line, done: number, total: number) => ({
  number: c.number, isOpening: c.isOpening, material: l.material.name, unit: l.material.uom, counted: num(l.countedQty), system: c.isOpening ? null : Number(l.systemQty),
  difference: c.isOpening ? null : num(l.differenceQty), reason: l.reasonCode, rate: num(l.unitRate), invoiceNo: l.sourceInvoiceNo, done, total,
});

async function progressOfCount(db: Db, countId: string) {
  const [total, done] = await Promise.all([db.stockCountLine.count({ where: { stockCountId: countId } }), db.stockCountLine.count({ where: { stockCountId: countId, countedQty: { not: null } } })]);
  return { total, done };
}

export const submitCountLine = defineTool({
  name: 'submit_count_line', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ stockCountLineId: z.string({ required_error: 'Choose the material.' }).min(1, 'Choose the material.').max(64), ...editShape }),
  form: {
    title: 'Enter a count', verb: 'Save count',
    fields: [
      { name: 'countKind', label: 'Kind', type: 'hidden' },
      { name: 'stockCountLineId', label: 'Material', type: 'countLine', required: true },
      { name: 'countedQty', label: 'Counted', type: 'number', hint: 'What you counted, in the unit shown. Leave empty if you are only adding the rate.' },
      { name: 'reasonCode', label: 'If it differs, why?', type: 'select', showWhen: { field: 'countKind', in: ['normal'] },
        options: REASONS.map((r) => ({ value: r, label: REASON_TEXT[r] })), hint: "Only if the count differs from the system. \"Don't know\" is fine." },
      { name: 'unitRate', label: 'Rate from the last purchase invoice', type: 'number', unit: '₹', showWhen: { field: 'countKind', in: ['opening'] }, hint: 'Take it from the invoice. Never an estimate.' },
      { name: 'sourceInvoiceNo', label: 'Invoice number (if you have it)', type: 'text', showWhen: { field: 'countKind', in: ['opening'] } },
      { name: 'sourceInvoiceDate', label: 'Invoice date', type: 'date', showWhen: { field: 'countKind', in: ['opening'] } },
      { name: 'notes', label: 'Note', type: 'text' },
    ],
  },
  stamp: 'COUNT SAVED',
  describe: lineSummary,
  preview: async (ctx) => {
    const c = await openCount(ctx.db);
    if (!c) return { info: ['There is no count in progress. Start one first.'] };
    const p = await progressOfCount(ctx.db, c.id);
    return { info: [`${c.number} · ${p.done} of ${p.total} counted`], values: { countKind: c.isOpening ? 'opening' : 'normal' } };
  },
  handler: async (ctx, input) => {
    const line = await ctx.db.stockCountLine.findUnique({ where: { id: input.stockCountLineId }, include: { ...withMaterial, stockCount: true } });
    if (!line) throw new ToolError('NOT_FOUND', "Couldn't find that material in the count.", undefined, 'stockCountLineId');
    assertEditable(line.stockCount);
    const before = toLine(line.stockCount.isOpening, line);
    const updated = await applyEdit(ctx.db, line.stockCount, line, { ...input, reasonCode: input.reasonCode as Reason | undefined });
    const p = await progressOfCount(ctx.db, line.stockCountId);
    return {
      data: { ...toLine(line.stockCount.isOpening, updated), done: p.done, total: p.total, number: line.stockCount.number },
      audit: { entityType: 'StockCountLine', entityId: line.id, action: 'UPDATE', before: { counted: before.countedQty, reason: before.reason, rate: before.unitRate }, after: afterLine(line.stockCount, updated, p.done, p.total) },
    };
  },
  followUps: async (ctx) => {
    const left = await ctx.read('list_count_lines', { onlyUnfinished: true });
    const none = left.ok && (left.data as { rows: unknown[] }).rows.length === 0;
    return { facts: [], chips: none ? [{ label: 'Send to owner', form: 'submit_stock_count' }, { label: 'Open the count sheet', sheet: true as const }] : [{ label: 'Open the count sheet', sheet: true as const }] };
  },
});

// ── save_count_sheet (the count sheet saves a row at a time; it is the sheet, not the assistant) ───
export const saveCountSheet = defineTool({
  name: 'save_count_sheet', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    stockCountId: z.string({ required_error: 'Choose the count.' }).min(1).max(64),
    lines: z.array(z.object({ stockCountLineId: z.string().min(1).max(64), ...editShape })).min(1, 'Nothing to save.').max(300),
  }),
  form: { title: 'Count sheet', verb: 'Save', fields: [] },
  stamp: 'COUNT SHEET SAVED',
  describe: (a) => [String(a.number), `${a.saved} row${a.saved === 1 ? '' : 's'} saved · ${a.done} of ${a.total} counted`],
  handler: async (ctx, input) => {
    const count = await resolveCount(ctx.db, input.stockCountId);
    assertEditable(count);
    const ids = input.lines.map((l) => l.stockCountLineId);
    const lines = await ctx.db.stockCountLine.findMany({ where: { id: { in: ids }, stockCountId: count.id }, include: withMaterial });
    const byId = new Map(lines.map((l) => [l.id, l]));
    const saved: CountLineRow[] = [];
    for (const e of input.lines) {
      const line = byId.get(e.stockCountLineId);
      if (!line) throw new ToolError('NOT_FOUND', "One of those rows isn't in this count.");
      try {
        saved.push(toLine(count.isOpening, await applyEdit(ctx.db, count, line, { ...e, reasonCode: e.reasonCode as Reason | undefined })));
      } catch (err) {
        if (err instanceof ToolError) throw new ToolError(err.code, `${line.material.name}: ${err.message}`, { stockCountLineId: line.id }, err.field);
        throw err;
      }
    }
    const p = await progressOfCount(ctx.db, count.id);
    return { data: { rows: saved, done: p.done, total: p.total, number: count.number }, audit: { entityType: 'StockCount', entityId: count.id, action: 'UPDATE', after: { number: count.number, saved: saved.length, done: p.done, total: p.total, materials: saved.map((r) => r.material) } } };
  },
});

// ── submit_stock_count ─────────────────────────────────────────────────────────────────────────────
function incompleteMessage(isOpening: boolean, lines: Line[]) {
  const noQty = lines.filter((l) => l.countedQty === null).map((l) => l.material.name);
  const noRate = isOpening ? lines.filter((l) => l.countedQty !== null && Number(l.countedQty) > 0 && l.unitRate === null).map((l) => l.material.name) : [];
  const parts: string[] = [];
  if (noQty.length) parts.push(`Not counted yet: ${names(noQty)}.`);
  if (noRate.length) parts.push(`No rate yet: ${names(noRate)}.`);
  return { text: parts.join(' '), names: [...noQty, ...noRate] };
}

export const submitStockCount = defineTool({
  name: 'submit_stock_count', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ stockCountId: countId }),
  form: { title: 'Send count to the owner', verb: 'Send to owner', fields: [{ name: 'stockCountId', label: 'Count', type: 'hidden' }] },
  stamp: 'SENT TO OWNER',
  describe: (a) => [`${a.number} (${String(a.kind).toLowerCase()})`, String(a.summary), 'Stock does not change until the owner approves.'],
  preview: async (ctx, input) => {
    const c = input.stockCountId ? await ctx.db.stockCount.findUnique({ where: { id: String(input.stockCountId) } }) : await openCount(ctx.db);
    if (!c) return { info: ['There is no count to send.'] };
    const s = await summarize(ctx.db, c);
    const info = [`${c.number} · ${kindText(c)} · ${s.counted} of ${s.total} counted`];
    if (c.status === 'PENDING_APPROVAL') info.push('It is already with the owner.');
    else {
      const m = incompleteMessage(c.isOpening, s.lines);
      info.push(m.text || s.text);
      if (c.status === 'REJECTED' && c.rejectionNote) info.push(`The owner asked: ${c.rejectionNote}`);
    }
    return { info, values: { stockCountId: c.id } };
  },
  handler: async (ctx, input) => {
    const count = await resolveCount(ctx.db, input.stockCountId);
    assertEditable(count);
    const lines = await ctx.db.stockCountLine.findMany({ where: { stockCountId: count.id }, include: withMaterial, orderBy: { material: { name: 'asc' } } });
    const gaps = incompleteMessage(count.isOpening, lines);
    if (gaps.names.length) throw new ToolError('COUNT_INCOMPLETE', gaps.text, { names: gaps.names });
    const resent = count.status === 'REJECTED';
    await ctx.db.stockCount.update({ where: { id: count.id }, data: { status: 'PENDING_APPROVAL', countedById: ctx.session.userId, rejectionNote: null } });
    const s = await summarize(ctx.db, count);
    await notify(ctx.db, await ownerIds(ctx.db), {
      type: 'COUNT_PENDING_APPROVAL', title: `${kindText(count)} ${resent ? 'sent again' : 'waiting'}`, body: `${count.number}: ${s.text}`, entityType: 'StockCount', entityId: count.id,
    }, ctx.session.userId);
    return {
      data: { number: count.number, kind: kindText(count), summary: s.text, resent },
      audit: { entityType: 'StockCount', entityId: count.id, action: 'SUBMIT', after: { number: count.number, kind: kindText(count), summary: s.text, materials: s.total, totalValue: s.totalValue, differing: s.differing, short: s.short, over: s.over, resent } },
    };
  },
});

// ── approve_stock_count ────────────────────────────────────────────────────────────────────────────
export const approveStockCount = defineTool({
  name: 'approve_stock_count', kind: 'write', roles: ['OWNER'],
  input: z.object({ stockCountId: countId }),
  form: { title: 'Approve the count', verb: 'Approve', fields: [{ name: 'stockCountId', label: 'Count', type: 'hidden' }], alt: { tool: 'reject_stock_count', label: 'Send back' } },
  stamp: 'COUNT APPROVED',
  describe: (a) => a.isOpening
    ? [`${a.number} approved`, `${a.posted} materials, total value ${inr(Number(a.totalValue))}`, 'Opening stock is in at invoice rates. The system is live.']
    : [`${a.number} approved`, a.adjustments ? `${a.adjustments} adjustment${a.adjustments === 1 ? '' : 's'} posted at the current average rate` : 'Nothing differed, so no stock changed'],
  preview: async (ctx, input) => {
    const c = await resolveCount(ctx.db, input.stockCountId ? String(input.stockCountId) : undefined, 'PENDING_APPROVAL').catch(() => null);
    if (!c) return { info: ['Nothing is waiting for approval.'] };
    const s = await summarize(ctx.db, c);
    const info = [`${c.number} · ${kindText(c)} · ${s.total} materials`, s.text];
    if (c.status !== 'PENDING_APPROVAL') info.push('It has not been sent to you yet.');
    else if (s.biggest.length) info.push(c.isOpening ? 'Biggest values:' : 'Biggest differences:', ...s.biggest);
    return { info, values: { stockCountId: c.id } };
  },
  handler: async (ctx, input) => {
    const count = await resolveCount(ctx.db, input.stockCountId, 'PENDING_APPROVAL');
    if (count.status !== 'PENDING_APPROVAL') throw new ToolError('NOT_PENDING', `${count.number} is not waiting for approval.`);
    if (count.isOpening && (await ctx.db.stockMovement.count()) > 0) {
      throw new ToolError('OPENING_NOT_FIRST', 'Stock has been recorded since this opening count was started, so approving it would count that stock twice. Send it back and start again.');
    }
    const s = await summarize(ctx.db, count);
    const balances = new Map((await ctx.db.stockBalance.findMany({ where: { materialId: { in: s.lines.map((l) => l.materialId) } } })).map((b) => [b.materialId, b.averageRate]));

    // Status first, in the same transaction: the ledger guard only lets stock move from a count that is already approved.
    await ctx.db.stockCount.update({ where: { id: count.id }, data: { status: 'APPROVED', approvedById: ctx.session.userId, approvedAt: ctx.now } });
    const who = { actorType: ctx.actor.actorType, actorId: ctx.actor.actorId, agentRunId: ctx.actor.agentRunId, toolName: ctx.actor.toolName };
    let posted = 0;
    for (const l of s.lines) {
      if (count.isOpening) {
        if (l.countedQty === null || l.countedQty.lte(0)) continue;
        await ctx.db.stockMovement.create({ data: { materialId: l.materialId, type: 'OPENING', direction: 'IN', quantity: l.countedQty, rate: l.unitRate ?? 0, stockCountLineId: l.id, movementDate: count.countDate, ...who } });
      } else {
        const diff = l.differenceQty;
        if (!diff || diff.isZero()) continue;
        await ctx.db.stockMovement.create({
          data: { materialId: l.materialId, type: 'COUNT_ADJUSTMENT', direction: diff.gt(0) ? 'IN' : 'OUT', quantity: diff.abs(), rate: balances.get(l.materialId) ?? 0, stockCountLineId: l.id, movementDate: count.countDate, reasonCode: l.reasonCode ?? 'UNEXPLAINED', ...who },
        });
      }
      posted++;
    }
    await notify(ctx.db, [count.countedById], {
      type: 'COUNT_APPROVED', title: `${kindText(count)} approved`,
      body: count.isOpening ? `${count.number} is approved. Opening stock is in at invoice rates. The system is live.` : `${count.number} is approved. ${posted} adjustment${posted === 1 ? '' : 's'} posted.`,
      entityType: 'StockCount', entityId: count.id,
    }, ctx.session.userId);
    return {
      data: { number: count.number, isOpening: count.isOpening, posted, totalValue: s.totalValue },
      audit: { entityType: 'StockCount', entityId: count.id, action: 'APPROVE', after: { number: count.number, isOpening: count.isOpening, posted, adjustments: count.isOpening ? 0 : posted, totalValue: s.totalValue, summary: s.text } },
    };
  },
  followUps: async (_ctx, _input, result) => ({
    facts: [],
    chips: (result as { isOpening?: boolean })?.isOpening ? [{ label: 'Show stock of everything', ask: 'Show stock on hand.' }] : [],
  }),
});

// ── reject_stock_count ─────────────────────────────────────────────────────────────────────────────
export const rejectStockCount = defineTool({
  name: 'reject_stock_count', kind: 'write', roles: ['OWNER'],
  input: z.object({ stockCountId: countId, rejectionNote: z.string({ required_error: 'Say what to recount or fix.', invalid_type_error: 'Say what to recount or fix.' }).trim().min(1, 'Say what to recount or fix.').max(300, 'Please keep the note short.') }),
  form: {
    title: 'Send the count back', verb: 'Send back',
    fields: [
      { name: 'stockCountId', label: 'Count', type: 'hidden' },
      { name: 'rejectionNote', label: 'What should be recounted or fixed?', type: 'text', required: true, suggestions: ['Please recount all of it', 'Something looks too low', 'Something looks too high', 'A rate looks wrong'] },
    ],
  },
  stamp: 'SENT BACK',
  describe: (a) => [`${a.number} sent back to the storekeeper`, `Your note: ${a.note}`, 'No stock has moved.'],
  preview: async (ctx, input) => {
    const c = await resolveCount(ctx.db, input.stockCountId ? String(input.stockCountId) : undefined, 'PENDING_APPROVAL').catch(() => null);
    if (!c) return { info: ['Nothing is waiting for approval.'] };
    return { info: [`${c.number} · ${kindText(c)}`, 'The storekeeper gets your note and fixes the same count.'], values: { stockCountId: c.id } };
  },
  handler: async (ctx, input) => {
    const count = await resolveCount(ctx.db, input.stockCountId, 'PENDING_APPROVAL');
    if (count.status !== 'PENDING_APPROVAL') throw new ToolError('NOT_PENDING', `${count.number} is not waiting for approval.`);
    await ctx.db.stockCount.update({ where: { id: count.id }, data: { status: 'REJECTED', rejectionNote: input.rejectionNote } });
    await notify(ctx.db, [count.countedById], { type: 'RECOUNT_REQUIRED', title: 'Recount needed', body: `${count.number}: ${input.rejectionNote}`, entityType: 'StockCount', entityId: count.id }, ctx.session.userId);
    return {
      data: { number: count.number, note: input.rejectionNote },
      audit: { entityType: 'StockCount', entityId: count.id, action: 'REJECT', reason: input.rejectionNote, after: { number: count.number, note: input.rejectionNote } },
    };
  },
});
