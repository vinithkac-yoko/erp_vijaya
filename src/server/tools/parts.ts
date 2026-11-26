import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Card } from '@/lib/cards';
import { dateText, groupIndian, perPieceText } from '@/lib/format';
import { partNumberKey } from '@/lib/names';
import { search } from '@/lib/similar';
import { ToolError } from '../errors';
import { defineTool } from './define';
import { flag, opt, tidy } from './helpers';
import { findParty } from './lookup';
import type { Db } from './types';

/**
 * Parts (milestone 11). Everything the factory makes runs by part number: the number the customer gives the product and the
 * factory puts on it. A part belongs to one customer (two customers may use the same number), carries a description and the
 * usual bill of materials for one piece. A new job starts from that BOM, and keeps its own copy.
 */
const MAX_ROWS = 200;
const emptyToUndef = (v: unknown) => (v === '' || v === null ? undefined : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOpt = z.preprocess(emptyToUndef, z.string().max(64).optional());
const num = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d));

const partInclude = { customer: { select: { name: true } }, _count: { select: { bomLines: true, jobs: true } } } as const;
type PartRow = Prisma.PartGetPayload<{ include: typeof partInclude }>;

export const partRowOf = (p: PartRow) => ({
  id: p.id, customerId: p.customerId, partNumber: p.partNumber, description: p.description, customer: p.customer.name, hsnCode: p.hsnCode,
  isActive: p.isActive, bomLines: p._count.bomLines, jobs: p._count.jobs,
});

/** The customer a part form names: by id (the picker) or by name (the assistant). */
const customerOf = (db: Db, input: { customerId?: string; customerName?: string }) => findParty(db, { id: input.customerId, name: input.customerName }, 'CUSTOMER');

/**
 * The part a person or the assistant means: its id (a picker), or the part number as typed. The same number under two customers
 * is asked about, never guessed; with a customer given it is exact.
 */
export async function findPart(db: Db, ref: string, customerId?: string): Promise<PartRow> {
  const r = ref.trim();
  if (UUID.test(r)) {
    const p = await db.part.findUnique({ where: { id: r }, include: partInclude });
    if (p) return p;
  } else if (r) {
    const key = partNumberKey(r);
    // a pasted "90308200008-TXFR FOR M634VOC" is the number, then the words
    const lead = /^\s*([A-Za-z0-9][A-Za-z0-9./]*)\s*[-–]/.exec(r)?.[1];
    const keys = [...new Set([key, ...(lead ? [partNumberKey(lead)] : [])])].filter(Boolean);
    const hits = await db.part.findMany({ where: { partKey: { in: keys }, ...(customerId ? { customerId } : {}) }, include: partInclude, take: 5 });
    if (hits.length === 1) return hits[0] as PartRow;
    if (hits.length > 1) {
      throw new ToolError('PART_AMBIGUOUS', `The part number ${hits[0]?.partNumber} is used for ${hits.map((h) => h.customer.name).join(' and ')}. Say which customer.`, { customers: hits.map((h) => h.customer.name) }, 'partId');
    }
  }
  throw new ToolError('NOT_FOUND', "Couldn't find that part number. Check it, or add the part first.", undefined, 'partId');
}

const partLabel = (p: { partNumber: string; description: string }) => `${p.partNumber} · ${p.description}`;

// ── create_part ────────────────────────────────────────────────────────────────────────────────────
export const createPart = defineTool({
  name: 'create_part', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    customerId: idOpt, customerName: opt(150),
    partNumber: z.string({ required_error: 'Type the part number.' }).trim().min(1, 'Type the part number.').max(40, 'That part number is too long.'),
    description: z.string({ required_error: 'Say what the part is.' }).trim().min(1, 'Say what the part is.').max(200, 'Please keep it short.'),
    hsnCode: opt(20),
  }),
  form: {
    title: 'Add a part', verb: 'Add part',
    intro: 'A product a customer buys, by its part number: the number the factory puts on it.',
    fields: [
      { name: 'customerId', label: 'Customer', type: 'party', partyRole: 'CUSTOMER', required: true },
      { name: 'partNumber', label: 'Part number', type: 'text', required: true, hint: 'As the customer writes it, like 90308200008.' },
      { name: 'description', label: 'What it is', type: 'text', required: true, hint: 'Like TXFR FOR M634VOC.' },
      { name: 'hsnCode', label: 'HSN code', type: 'text', hint: 'If you have it.' },
    ],
  },
  stamp: 'PART ADDED',
  describe: (a) => [`${a.partNumber} · ${a.description}`, `Customer: ${a.customer}`, ...(a.sameNumberFor ? [`The same number is also used for ${a.sameNumberFor}.`] : []), 'Next: add its bill of materials.'],
  preview: async (ctx, input) => {
    const info: string[] = [];
    const values: Record<string, unknown> = {};
    if (!input.customerId && typeof input.customerName === 'string' && input.customerName.trim()) {
      try { values.customerId = (await customerOf(ctx.db, { customerName: input.customerName })).id; } catch (e) { info.push(e instanceof ToolError ? e.message : 'Choose the customer.'); }
    }
    return { info, values };
  },
  handler: async (ctx, input) => {
    const customer = await customerOf(ctx.db, input);
    const partNumber = tidy(input.partNumber);
    const key = partNumberKey(partNumber);
    if (!key) throw new ToolError('INVALID_INPUT', 'Type the part number.', undefined, 'partNumber');
    const same = await ctx.db.part.findUnique({ where: { customerId_partKey: { customerId: customer.id, partKey: key } } });
    if (same) throw new ToolError('PART_EXISTS', `${customer.name} already has the part ${same.partNumber} (${same.description}).`, undefined, 'partNumber');
    const others = await ctx.db.part.findMany({ where: { partKey: key, NOT: { customerId: customer.id } }, include: { customer: { select: { name: true } } }, take: 3 });
    const p = await ctx.db.part.create({ data: { customerId: customer.id, partNumber, partKey: key, description: tidy(input.description), hsnCode: input.hsnCode } });
    const sameNumberFor = others.map((o) => o.customer.name).join(', ') || null;
    return {
      data: { id: p.id, partNumber: p.partNumber, description: p.description, customer: customer.name },
      audit: { entityType: 'Part', entityId: p.id, action: 'CREATE', after: { partNumber: p.partNumber, description: p.description, customer: customer.name, hsnCode: p.hsnCode, sameNumberFor } },
    };
  },
  followUps: async (_ctx, _input, result) => {
    const r = result as { id: string };
    return { facts: [], chips: [{ label: 'Add its BOM', form: 'set_part_bom', prefill: { partId: r.id } }, { label: 'Create a job for it', form: 'create_job', prefill: { partId: r.id } }] };
  },
});

// ── update_part ────────────────────────────────────────────────────────────────────────────────────
export const updatePart = defineTool({
  name: 'update_part', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ partId: z.string({ required_error: 'Choose the part.' }).min(1, 'Choose the part.').max(64), partNumber: opt(40), description: opt(200), hsnCode: opt(20), noLongerMade: flag.optional() }),
  form: {
    title: 'Change a part', verb: 'Save changes', intro: 'Leave a box empty to keep what is there. Jobs already made keep the number they had.',
    fields: [
      { name: 'partId', label: 'Part', type: 'part', required: true },
      { name: 'partNumber', label: 'Correct part number', type: 'text', hint: 'Only to fix a typing mistake.' },
      { name: 'description', label: 'What it is', type: 'text' },
      { name: 'hsnCode', label: 'HSN code', type: 'text' },
      { name: 'noLongerMade', label: 'This part is no longer made', type: 'checkbox' },
    ],
  },
  stamp: 'PART CHANGED',
  describe: (a) => [`${a.partNumber} · ${a.description}`, ...Object.entries((a.changes ?? {}) as Record<string, unknown>).map(([k, v]) => `${k}: ${v}`)],
  handler: async (ctx, input) => {
    const p = await findPart(ctx.db, input.partId);
    const data: Prisma.PartUpdateInput = {};
    const changes: Record<string, unknown> = {};
    if (input.partNumber !== undefined && tidy(input.partNumber) !== p.partNumber) {
      const number = tidy(input.partNumber), key = partNumberKey(number);
      const clash = await ctx.db.part.findFirst({ where: { customerId: p.customerId, partKey: key, NOT: { id: p.id } }, select: { partNumber: true } });
      if (clash) throw new ToolError('PART_EXISTS', `${p.customer.name} already has the part ${clash.partNumber}.`, undefined, 'partNumber');
      data.partNumber = number; data.partKey = key; changes['Part number'] = number;
    }
    if (input.description !== undefined && tidy(input.description) !== p.description) { data.description = tidy(input.description); changes['What it is'] = tidy(input.description); }
    if (input.hsnCode !== undefined && input.hsnCode !== p.hsnCode) { data.hsnCode = input.hsnCode; changes['HSN code'] = input.hsnCode; }
    if (input.noLongerMade && p.isActive) { data.isActive = false; changes.Status = 'No longer made'; }
    if (Object.keys(changes).length === 0) throw new ToolError('NOTHING_TO_CHANGE', 'Nothing to change. Fill in what should be different.');
    const u = await ctx.db.part.update({ where: { id: p.id }, data });
    return {
      data: { partNumber: u.partNumber },
      audit: { entityType: 'Part', entityId: p.id, action: 'UPDATE', before: { partNumber: p.partNumber, description: p.description, hsnCode: p.hsnCode, isActive: p.isActive }, after: { partNumber: u.partNumber, description: u.description, changes, customer: p.customer.name } },
    };
  },
});

// ── set_part_bom ───────────────────────────────────────────────────────────────────────────────────
const bomLine = z.object({
  materialId: z.string({ required_error: 'Choose the material.' }).min(1, 'Choose the material.').max(64),
  qtyPerPiece: z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/,/g, '')) : v),
    z.number({ required_error: 'Type the quantity for one piece.', invalid_type_error: 'Type the quantity for one piece, as a number.' }).gt(0, 'The quantity must be more than zero.').max(1_000_000, 'That is too big for one piece.')),
});

/** Saves a part's usual BOM (replacing it). Used by set_part_bom and by a job's "remember this for the part". */
export async function savePartBom(db: Db, partId: string, lines: { materialId: string; qtyPerPiece: number }[]) {
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.materialId)) throw new ToolError('DUPLICATE_LINE', 'A material is listed twice. Put it on one line.', undefined, 'lines');
    seen.add(l.materialId);
  }
  const mats = await db.material.findMany({ where: { id: { in: lines.map((l) => l.materialId) } }, select: { id: true, name: true, uom: true, isActive: true } });
  for (const l of lines) {
    const m = mats.find((x) => x.id === l.materialId);
    if (!m) throw new ToolError('NOT_FOUND', "Couldn't find one of those materials.", undefined, 'lines');
    if (!m.isActive) throw new ToolError('MATERIAL_INACTIVE', `${m.name} is no longer in use.`, undefined, 'lines');
  }
  await db.partBomLine.deleteMany({ where: { partId } });
  await db.partBomLine.createMany({ data: lines.map((l) => ({ partId, materialId: l.materialId, qtyPerPiece: l.qtyPerPiece })) });
  return lines.map((l) => { const m = mats.find((x) => x.id === l.materialId)!; return { material: m.name, each: perPieceText(l.qtyPerPiece, m.uom) }; })
    .sort((a, b) => a.material.localeCompare(b.material));
}

export async function partBomOf(db: Db, partId: string) {
  const lines = await db.partBomLine.findMany({ where: { partId }, include: { material: { select: { name: true, uom: true, itemCode: true } } }, orderBy: { material: { name: 'asc' } } });
  return lines.map((l) => ({ materialId: l.materialId, material: l.material.name, itemCode: l.material.itemCode, unit: l.material.uom, qtyPerPiece: Number(l.qtyPerPiece), perPieceText: perPieceText(Number(l.qtyPerPiece), l.material.uom) }));
}

export const setPartBom = defineTool({
  name: 'set_part_bom', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    partId: z.string({ required_error: 'Choose the part.' }).min(1, 'Choose the part.').max(64),
    lines: z.array(bomLine, { required_error: 'Add at least one material.' }).min(1, 'Add at least one material.').max(60, 'That is a lot of lines.'),
  }),
  form: {
    title: 'Usual bill of materials for a part', verb: 'Save BOM',
    intro: 'Quantities are for ONE piece. A new job for this part starts from this list; each job keeps its own copy.',
    fields: [
      { name: 'partId', label: 'Part', type: 'part', required: true },
      { name: 'lines', label: 'Materials, for one piece', type: 'bomLines', required: true },
    ],
  },
  stamp: 'PART BOM SAVED',
  describe: (a) => [`${a.partNumber} · ${a.description}`, ...((a.lines as { material: string; each: string }[]) ?? []).map((l) => `${l.material} — ${l.each} each`), 'New jobs for this part start from this list.'],
  preview: async (ctx, input) => {
    if (typeof input.partId !== 'string' || !input.partId) return { info: [], values: {} };
    try {
      const p = await findPart(ctx.db, input.partId);
      const values: Record<string, unknown> = { partId: p.id };
      const info = [partLabel(p)];
      if (!input.lines) {
        const now = await partBomOf(ctx.db, p.id);
        if (now.length) { values.lines = now.map((b) => ({ materialId: b.materialId, qtyPerPiece: b.qtyPerPiece })); info.push('This part already has a usual bill of materials. Saving replaces it.'); }
      }
      return { info, values };
    } catch (e) { return { info: [e instanceof ToolError ? e.message : 'Choose the part.'], values: {} }; }
  },
  handler: async (ctx, input) => {
    const p = await findPart(ctx.db, input.partId);
    const lines = await savePartBom(ctx.db, p.id, input.lines);
    return {
      data: { id: p.id, partNumber: p.partNumber, lines: lines.length },
      audit: { entityType: 'Part', entityId: p.id, action: 'BOM', after: { partNumber: p.partNumber, description: p.description, customer: p.customer.name, lines } },
    };
  },
});

// ── list_parts ─────────────────────────────────────────────────────────────────────────────────────
export const listParts = defineTool({
  name: 'list_parts', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ query: opt(100), customerId: idOpt, customerName: opt(150), includeInactive: flag.optional() }),
  handler: async (ctx, input) => {
    const customer = input.customerId || input.customerName ? await customerOf(ctx.db, input) : null;
    let rows = await ctx.db.part.findMany({ where: { ...(customer ? { customerId: customer.id } : {}), ...(input.includeInactive ? {} : { isActive: true }) }, include: partInclude, orderBy: [{ partNumber: 'asc' }], take: 1000 });
    if (input.query) {
      const key = partNumberKey(input.query);
      // a part number, or part of one (at least three characters), or words from the description
      const byNumber = key.length >= 3 ? rows.filter((r) => r.partKey.includes(key)) : [];
      rows = byNumber.length ? byNumber : search(input.query, rows, (r) => `${r.partKey}${partNumberKey(r.description)}`, (r) => `${r.partNumber} ${r.description}`);
    }
    return { total: rows.length, rows: rows.slice(0, MAX_ROWS).map(partRowOf) };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'p', label: 'Part number' }, { key: 'd', label: 'What it is' }, { key: 'c', label: 'Customer' }, { key: 'b', label: 'BOM' }],
    rows: d.rows.slice(0, 10).map((r) => ({ p: r.partNumber, d: r.description, c: r.customer, b: r.bomLines ? `${r.bomLines} material${r.bomLines === 1 ? '' : 's'}` : 'none yet' })),
    note: d.rows.length === 0 ? 'No part like that is saved yet.' : d.total > 10 ? `Showing 10 of ${d.total}.` : undefined,
  }],
});

// ── get_part ───────────────────────────────────────────────────────────────────────────────────────
export const getPart = defineTool({
  name: 'get_part', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ partId: z.string({ required_error: 'Which part?' }).min(1, 'Which part?').max(100), customerId: idOpt, customerName: opt(150) }),
  handler: async (ctx, input) => {
    const customer = input.customerId || input.customerName ? await customerOf(ctx.db, input) : null;
    const p = await findPart(ctx.db, input.partId, customer?.id);
    const bom = await partBomOf(ctx.db, p.id);
    const jobs = await ctx.db.job.findMany({ where: { partId: p.id }, orderBy: [{ jobDate: 'desc' }], take: 10, select: { number: true, quantity: true, status: true, jobDate: true, type: true } });
    const owner = ctx.session.role === 'OWNER';
    // what the customer pays is the owner's number
    const orders = await ctx.db.customerPoLine.findMany({ where: { partId: p.id }, include: { customerPo: { select: { number: true } } }, orderBy: { createdAt: 'desc' }, take: 10 });
    return {
      part: partRowOf(p), bom,
      jobs: jobs.map((j) => ({ number: j.number, quantity: j.quantity, status: j.status, date: j.jobDate.toISOString(), type: j.type })),
      orders: orders.map((o) => ({ customerPo: o.customerPo.number, quantity: o.quantity, rate: owner ? num(o.rate) : null })),
    };
  },
  view: (d) => {
    const cards: Card[] = [{
      kind: 'table', title: `${d.part.partNumber} · ${d.part.description} · ${d.part.customer}`,
      columns: [{ key: 'm', label: 'Material' }, { key: 'p', label: 'For one piece', align: 'right' }],
      rows: d.bom.slice(0, 12).map((b) => ({ m: b.itemCode ? `${b.material} (${b.itemCode})` : b.material, p: b.perPieceText })),
      note: d.bom.length === 0 ? 'No usual bill of materials yet.' : `${d.part.jobs} job${d.part.jobs === 1 ? '' : 's'} so far.`,
    }];
    if (d.jobs.length) {
      cards.push({
        kind: 'table', title: 'Recent jobs', columns: [{ key: 'j', label: 'Job' }, { key: 'q', label: 'Pieces', align: 'right' }, { key: 'd', label: 'Date' }],
        rows: d.jobs.slice(0, 5).map((j) => ({ j: j.number + (j.type === 'SAMPLE' ? ' (sample)' : ''), q: groupIndian(j.quantity), d: dateText(new Date(j.date)) })),
      });
    }
    return cards;
  },
});
