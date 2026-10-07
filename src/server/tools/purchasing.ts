import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { materialNameKey } from '@/lib/names';
import { dateText, inr, qty, UOM_LONG, UOM_SHORT } from '@/lib/format';
import { search } from '@/lib/similar';
import { ToolError } from '../errors';
import { defineTool } from './define';
import { flag, opt } from './helpers';
import { findParty } from './lookup';
import { notify, ownerIds } from './notifications';
import { nextNumber } from './numbers';
import { findJob, jobLabel } from './jobs';
import { readSetting } from './settings';
import type { Db } from './types';

// ── words and small helpers ────────────────────────────────────────────────────────────────────────
const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'REJECTED'] as const;
type Status = (typeof STATUSES)[number];
export const PO_STATUS_TEXT: Record<Status, string> = {
  DRAFT: 'Draft', PENDING_APPROVAL: 'Waiting for the owner', APPROVED: 'Approved', PARTIALLY_RECEIVED: 'Partly received', RECEIVED: 'Received', CANCELLED: 'Cancelled', REJECTED: 'Rejected',
};
/** Pieces and sets are ordered whole. */
const WHOLE_UNITS = new Set(['NOS', 'SET']);
/** A typed rate under half, or over double, the last one paid is asked about once (BUSINESS_FLOW §9). */
export const RATE_LOW = 0.5;
export const RATE_HIGH = 2;
const MAX_ROWS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const round2 = (n: number) => Math.round(n * 100) / 100;
const emptyToUndef = (v: unknown) => (v === '' || v === null ? undefined : v);
const validYmd = (s: string) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const dateOpt = z.preprocess(emptyToUndef, z.string().refine(validYmd, 'That is not a real date.').optional());
const istDate = (ymd: string) => new Date(`${ymd}T00:00:00+05:30`);
export const rateText = (rate: number, uom: string) => `₹${rate.toLocaleString('en-IN', { maximumFractionDigits: 4 })}/${UOM_SHORT[uom] ?? uom.toLowerCase()}`;

const poInclude = {
  supplier: { select: { id: true, name: true } }, triggeredByJob: { select: { id: true, number: true } },
  lines: { include: { material: { select: { name: true, uom: true } } }, orderBy: { material: { name: 'asc' } } },
} as const;
export type PoRow = Prisma.PurchaseOrderGetPayload<{ include: typeof poInclude }>;

/** The PO by its id, its number ("PO-2627-0015") or just the end of it ("15"). */
export async function findPo(db: Db, ref: string): Promise<PoRow> {
  const r = ref.trim();
  if (UUID.test(r)) {
    const po = await db.purchaseOrder.findUnique({ where: { id: r }, include: poInclude });
    if (po) return po;
  } else if (r) {
    const digits = r.replace(/^po[-\s]*/i, '');
    const po = await db.purchaseOrder.findFirst({
      where: { OR: [{ number: { equals: r, mode: 'insensitive' } }, ...(/^\d+$/.test(digits) ? [{ number: { endsWith: `-${digits.padStart(4, '0')}` } }] : [])] },
      orderBy: { poDate: 'desc' }, include: poInclude,
    });
    if (po) return po;
  }
  throw new ToolError('NOT_FOUND', "Couldn't find that purchase order. Check the number.", undefined, 'purchaseOrderId');
}

/** The newest receipt rate for a material (optionally from one supplier): what "last time" means. */
export async function lastReceipt(db: Db, materialId: string, supplierId?: string) {
  const l = await db.goodsReceiptLine.findFirst({
    where: { materialId, acceptedQty: { gt: 0 }, ...(supplierId ? { goodsReceipt: { supplierId } } : {}) },
    orderBy: [{ goodsReceipt: { receiptDate: 'desc' } }, { goodsReceipt: { createdAt: 'desc' } }],
    include: { goodsReceipt: { select: { receiptDate: true, supplier: { select: { name: true } } } }, material: { select: { uom: true } } },
  });
  return l ? { rate: Number(l.rate), uom: l.material.uom, supplier: l.goodsReceipt.supplier.name, date: l.goodsReceipt.receiptDate } : null;
}
export const lastRateText = (l: NonNullable<Awaited<ReturnType<typeof lastReceipt>>>) => `Last paid ${rateText(l.rate, l.uom)} · ${l.supplier} · ${dateText(l.date)}`;

const lineText = (l: { material: string; unit: string; quantity: number; rate: number; amount: number }) =>
  `${l.material}: ${qty(l.quantity, l.unit)} at ${rateText(l.rate, l.unit)} = ${inr(l.amount)}`;

const rowOf = (po: PoRow) => ({
  id: po.id, number: po.number, supplierId: po.supplierId, supplier: po.supplier.name, date: po.poDate.toISOString(), status: po.status, statusText: PO_STATUS_TEXT[po.status],
  total: Number(po.totalValue), expectedDate: po.expectedDate?.toISOString() ?? null, job: po.triggeredByJob?.number ?? null, rejectionReason: po.rejectionReason,
});

// ── create_purchase_order ──────────────────────────────────────────────────────────────────────────
const poLine = z.object({
  materialId: z.string({ required_error: 'Choose the material.' }).min(1, 'Choose the material.').max(64),
  quantity: z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/,/g, '')) : v),
    z.number({ required_error: 'How much?', invalid_type_error: 'Type the quantity as a number.' }).gt(0, 'The quantity must be more than zero.').max(1e9, 'That quantity is too big.')),
  rate: z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/[₹,\s]/g, '')) : v === '' || v === null ? undefined : v),
    z.number({ required_error: "Type the rate from the supplier's quote.", invalid_type_error: 'Type the rate as a number.' }).gt(0, "Type the rate from the supplier's quote. It can't be zero.").max(1e9, 'That rate is too big.')),
  hsnCode: opt(20),
  gstRate: z.preprocess(emptyToUndef, z.number({ invalid_type_error: 'Type the GST rate as a number.' }).min(0).max(100, 'A GST rate is between 0 and 100.').optional()),
});

export const createPurchaseOrder = defineTool({
  name: 'create_purchase_order', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    supplierName: opt(150), supplierId: z.preprocess(emptyToUndef, z.string().max(64).optional()),
    lines: z.array(poLine, { required_error: 'Add at least one material.' }).min(1, 'Add at least one material.').max(60, 'That is a lot of lines.'),
    expectedDate: dateOpt, triggeredByJobId: z.preprocess(emptyToUndef, z.string().max(64).optional()), confirmUnusual: flag.optional(),
  }),
  form: {
    title: 'Purchase order', verb: 'Raise PO',
    fields: [
      { name: 'approvalLimit', label: 'Limit', type: 'hidden' },
      { name: 'supplierId', label: 'Supplier', type: 'party', partyRole: 'SUPPLIER', required: true },
      { name: 'triggeredByJobId', label: 'For which job? (if any)', type: 'job', pickerFilter: 'open' },
      { name: 'expectedDate', label: 'Expected on (if the supplier said)', type: 'date' },
      { name: 'lines', label: 'Materials', type: 'poLines', required: true },
    ],
  },
  stamp: 'PO RAISED',
  describe: (a) => [
    `${a.number} · ${a.supplier}`,
    ...((a.lines as { material: string; unit: string; quantity: number; rate: number; amount: number }[]) ?? []).map(lineText),
    `Total ${inr(Number(a.total))}${a.gst ? ` including GST ${inr(Number(a.gst))}` : ''}`,
    ...(a.job ? [`For ${a.job}`] : []),
    a.status === 'PENDING_APPROVAL' ? `That is above the limit of ${inr(Number(a.limit))}, so it waits for the owner. You will be told.` : `Within the limit of ${inr(Number(a.limit))}, so it is approved. It can go to the supplier.`,
  ],
  preview: async (ctx, input) => {
    const values: Record<string, unknown> = {};
    const info: string[] = [];
    try { values.approvalLimit = Number(await readSetting(ctx.db, 'po.approval_limit')); info.push(`Above ${inr(Number(values.approvalLimit))} the owner approves it; at or below, it is approved at once.`); }
    catch (e) { info.push(e instanceof ToolError ? e.message : 'The approval limit could not be read.'); }
    if (!input.supplierId && typeof input.supplierName === 'string' && input.supplierName.trim()) {
      try { values.supplierId = (await findParty(ctx.db, { name: input.supplierName }, 'SUPPLIER')).id; } catch (e) { info.push(e instanceof ToolError ? e.message : 'Choose the supplier.'); }
    }
    if (typeof input.triggeredByJobId === 'string' && input.triggeredByJobId) {
      try { const j = await findJob(ctx.db, input.triggeredByJobId); values.triggeredByJobId = j.id; info.push(`For ${jobLabel(j)}`); } catch { /* the picker will say */ }
    }
    return { info, values };
  },
  handler: async (ctx, input) => {
    const supplier = await findParty(ctx.db, { id: input.supplierId, name: input.supplierName }, 'SUPPLIER');
    const mats = await ctx.db.material.findMany({ where: { id: { in: input.lines.map((l) => l.materialId) } } });
    const byId = new Map(mats.map((m) => [m.id, m]));
    const seen = new Set<string>();
    const warnings: string[] = [];
    const lines = [];
    for (const l of input.lines) {
      const m = byId.get(l.materialId);
      if (!m || !m.isActive) throw new ToolError('NOT_FOUND', "One of those materials couldn't be found.", undefined, 'lines');
      if (seen.has(m.id)) throw new ToolError('DUPLICATE_LINE', `${m.name} is on the list twice. Put it on one line.`, undefined, 'lines');
      seen.add(m.id);
      if (WHOLE_UNITS.has(m.uom) && !Number.isInteger(l.quantity)) throw new ToolError('INVALID_QUANTITY', `${m.name} is ordered in whole ${UOM_LONG[m.uom] ?? 'units'}. ${l.quantity} isn't possible.`, undefined, 'lines');
      const last = await lastReceipt(ctx.db, m.id);
      if (last && (l.rate < last.rate * RATE_LOW || l.rate > last.rate * RATE_HIGH)) {
        warnings.push(`${rateText(l.rate, m.uom)} for ${m.name} is ${l.rate < last.rate ? 'far below' : 'far above'} the last rate paid (${rateText(last.rate, m.uom)}).`);
      }
      const amount = round2(l.quantity * l.rate);
      lines.push({ m, quantity: l.quantity, rate: l.rate, hsnCode: l.hsnCode, gstRate: l.gstRate, amount, gst: l.gstRate ? round2((amount * l.gstRate) / 100) : 0 });
    }
    if (warnings.length && !input.confirmUnusual) throw new ToolError('CONFIRM_UNUSUAL_RATE', `${warnings.join(' ')} Is that right?`, { materials: lines.map((x) => x.m.name) }, 'lines');

    let job: { id: string; number: string } | null = null;
    if (input.triggeredByJobId) { const j = await findJob(ctx.db, input.triggeredByJobId); job = { id: j.id, number: j.number }; }

    const subTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const gst = round2(lines.reduce((s, l) => s + l.gst, 0));
    const total = round2(subTotal + gst);
    const limit = Number(await readSetting(ctx.db, 'po.approval_limit')); // a missing limit is an error, never a made-up one
    const status: Status = total > limit ? 'PENDING_APPROVAL' : 'APPROVED';

    const poDate = ctx.now;
    const po = await ctx.db.purchaseOrder.create({
      data: {
        number: await nextNumber(ctx.db, 'PO', poDate), supplierId: supplier.id, poDate, status, triggeredByJobId: job?.id, subTotal, gstAmount: gst, totalValue: total,
        expectedDate: input.expectedDate ? istDate(input.expectedDate) : null, createdById: ctx.session.userId, ...(status === 'APPROVED' ? { approvedAt: poDate } : {}),
        lines: { create: lines.map((l) => ({ materialId: l.m.id, quantity: l.quantity, rate: l.rate, hsnCode: l.hsnCode, gstRate: l.gstRate, amount: l.amount })) },
      },
    });
    if (status === 'PENDING_APPROVAL') {
      await notify(ctx.db, await ownerIds(ctx.db), {
        type: 'PO_PENDING_APPROVAL', title: 'Purchase order waiting', body: `${po.number}: ${supplier.name}, ${inr(total)}${job ? `, for ${job.number}` : ''}.`, entityType: 'PurchaseOrder', entityId: po.id,
      }, ctx.session.userId);
    }
    const shown = lines.map((l) => ({ material: l.m.name, unit: l.m.uom, quantity: l.quantity, rate: l.rate, amount: l.amount }));
    return {
      data: { id: po.id, number: po.number, supplier: supplier.name, total, status, autoApproved: status === 'APPROVED', limit },
      audit: { entityType: 'PurchaseOrder', entityId: po.id, action: 'CREATE', after: { number: po.number, supplier: supplier.name, total, gst, status, limit, job: job?.number ?? null, lines: shown } },
    };
  },
});

// ── cancel_purchase_order ──────────────────────────────────────────────────────────────────────────
export const cancelPurchaseOrder = defineTool({
  name: 'cancel_purchase_order', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    purchaseOrderId: z.string({ required_error: 'Choose the PO.' }).min(1, 'Choose the PO.').max(64),
    reason: z.string({ required_error: 'Say why.' }).trim().min(1, 'Say why.').max(300, 'Please keep it short.'),
  }),
  form: {
    title: 'Cancel a purchase order', verb: 'Cancel PO', intro: "Only while nothing has come against it. An approved PO can't be changed: cancel it and raise it again.",
    fields: [
      { name: 'purchaseOrderId', label: 'Purchase order', type: 'purchaseOrder', pickerFilter: 'cancellable', required: true },
      { name: 'reason', label: 'Why is it cancelled?', type: 'text', required: true },
    ],
  },
  stamp: 'PO CANCELLED',
  describe: (a) => [`${a.number} · ${a.supplier}`, `Total ${inr(Number(a.total))}`, `Reason: ${a.reason}`],
  handler: async (ctx, input) => {
    const po = await findPo(ctx.db, input.purchaseOrderId);
    if (po.status === 'CANCELLED') throw new ToolError('PO_ALREADY_CANCELLED', `${po.number} is already cancelled.`, undefined, 'purchaseOrderId');
    if (po.status === 'REJECTED') throw new ToolError('PO_NOT_OPEN', `${po.number} was rejected, so there is nothing to cancel.`, undefined, 'purchaseOrderId');
    const received = po.lines.some((l) => Number(l.receivedQty) > 0) || (await ctx.db.goodsReceipt.count({ where: { purchaseOrderId: po.id } })) > 0;
    if (received || po.status === 'RECEIVED' || po.status === 'PARTIALLY_RECEIVED') {
      throw new ToolError('PO_HAS_RECEIPTS', `Material has already come against ${po.number}, so it can't be cancelled.`, undefined, 'purchaseOrderId');
    }
    await ctx.db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'CANCELLED', notes: input.reason } });
    return {
      data: { number: po.number, supplier: po.supplier.name, total: Number(po.totalValue), reason: input.reason },
      audit: { entityType: 'PurchaseOrder', entityId: po.id, action: 'CANCEL', reason: input.reason, before: { status: po.status }, after: { number: po.number, supplier: po.supplier.name, total: Number(po.totalValue), reason: input.reason, status: 'CANCELLED' } },
    };
  },
});

// ── approve / reject ───────────────────────────────────────────────────────────────────────────────
/** The PO an approval form is about: the one named, or the oldest one waiting. */
async function pendingPo(db: Db, ref?: string) {
  if (ref) return findPo(db, ref);
  const po = await db.purchaseOrder.findFirst({ where: { status: 'PENDING_APPROVAL' }, orderBy: { createdAt: 'asc' }, include: poInclude });
  if (!po) throw new ToolError('NOT_FOUND', 'Nothing is waiting for approval.');
  return po;
}
const shownLines = (po: PoRow) => po.lines.map((l) => lineText({ material: l.material.name, unit: l.material.uom, quantity: Number(l.quantity), rate: Number(l.rate), amount: Number(l.amount) }));
const idOpt = z.preprocess(emptyToUndef, z.string().min(1).max(64).optional());

export const approvePurchaseOrder = defineTool({
  name: 'approve_purchase_order', kind: 'write', roles: ['OWNER'],
  input: z.object({ purchaseOrderId: idOpt }),
  form: { title: 'Approve the purchase order', verb: 'Approve', fields: [{ name: 'purchaseOrderId', label: 'PO', type: 'hidden' }], alt: { tool: 'reject_purchase_order', label: 'Reject' } },
  stamp: 'PO APPROVED',
  describe: (a) => [`${a.number} · ${a.supplier}`, `Total ${inr(Number(a.total))}`, 'The storekeeper is told. It can go to the supplier.'],
  preview: async (ctx, input) => {
    const po = await pendingPo(ctx.db, typeof input.purchaseOrderId === 'string' ? input.purchaseOrderId : undefined).catch(() => null);
    if (!po) return { info: ['Nothing is waiting for approval.'] };
    const info = [`${po.number} · ${po.supplier.name} · ${inr(Number(po.totalValue))}`, ...shownLines(po)];
    if (po.triggeredByJob) info.push(`Why: it is for ${po.triggeredByJob.number}.`);
    if (po.status !== 'PENDING_APPROVAL') info.push(`It is ${PO_STATUS_TEXT[po.status].toLowerCase()}, not waiting for approval.`);
    return { info, values: { purchaseOrderId: po.id } };
  },
  handler: async (ctx, input) => {
    const po = await pendingPo(ctx.db, input.purchaseOrderId);
    if (po.status !== 'PENDING_APPROVAL') throw new ToolError('NOT_PENDING', `${po.number} is not waiting for approval.`, undefined, 'purchaseOrderId');
    // material may already have come against it (the storekeeper was warned): the status then follows what has arrived
    const full = po.lines.every((l) => Number(l.receivedQty) >= Number(l.quantity));
    const some = po.lines.some((l) => Number(l.receivedQty) > 0);
    const status: Status = full ? 'RECEIVED' : some ? 'PARTIALLY_RECEIVED' : 'APPROVED';
    await ctx.db.purchaseOrder.update({ where: { id: po.id }, data: { status, approvedById: ctx.session.userId, approvedAt: ctx.now } });
    await notify(ctx.db, [po.createdById], { type: 'PO_APPROVED', title: 'Purchase order approved', body: `${po.number} to ${po.supplier.name} (${inr(Number(po.totalValue))}) is approved. It can go to the supplier.`, entityType: 'PurchaseOrder', entityId: po.id }, ctx.session.userId);
    return {
      data: { number: po.number, supplier: po.supplier.name, total: Number(po.totalValue) },
      audit: { entityType: 'PurchaseOrder', entityId: po.id, action: 'APPROVE', before: { status: po.status }, after: { number: po.number, supplier: po.supplier.name, total: Number(po.totalValue), status } },
    };
  },
});

export const rejectPurchaseOrder = defineTool({
  name: 'reject_purchase_order', kind: 'write', roles: ['OWNER'],
  input: z.object({ purchaseOrderId: idOpt, reason: z.string({ required_error: 'Say why.' }).trim().min(1, 'Say why.').max(300, 'Please keep it short.') }),
  form: {
    title: 'Reject the purchase order', verb: 'Reject',
    fields: [
      { name: 'purchaseOrderId', label: 'PO', type: 'hidden' },
      { name: 'reason', label: 'Why? The storekeeper will read this.', type: 'text', required: true, suggestions: ['The rate is too high', 'Not needed now', 'Wrong supplier', 'Order less'] },
    ],
  },
  stamp: 'PO REJECTED',
  describe: (a) => [`${a.number} · ${a.supplier}`, `Your reason: ${a.reason}`, 'No stock moves. The storekeeper is told.'],
  preview: async (ctx, input) => {
    const po = await pendingPo(ctx.db, typeof input.purchaseOrderId === 'string' ? input.purchaseOrderId : undefined).catch(() => null);
    if (!po) return { info: ['Nothing is waiting for approval.'] };
    return { info: [`${po.number} · ${po.supplier.name} · ${inr(Number(po.totalValue))}`], values: { purchaseOrderId: po.id } };
  },
  handler: async (ctx, input) => {
    const po = await pendingPo(ctx.db, input.purchaseOrderId);
    if (po.status !== 'PENDING_APPROVAL') throw new ToolError('NOT_PENDING', `${po.number} is not waiting for approval.`, undefined, 'purchaseOrderId');
    await ctx.db.purchaseOrder.update({ where: { id: po.id }, data: { status: 'REJECTED', rejectionReason: input.reason } });
    await notify(ctx.db, [po.createdById], { type: 'PO_REJECTED', title: 'Purchase order rejected', body: `${po.number} to ${po.supplier.name} was rejected: ${input.reason}`, entityType: 'PurchaseOrder', entityId: po.id }, ctx.session.userId);
    return {
      data: { number: po.number, supplier: po.supplier.name, reason: input.reason },
      audit: { entityType: 'PurchaseOrder', entityId: po.id, action: 'REJECT', reason: input.reason, before: { status: po.status }, after: { number: po.number, supplier: po.supplier.name, reason: input.reason, status: 'REJECTED' } },
    };
  },
});

// ── list_purchase_orders ───────────────────────────────────────────────────────────────────────────
export const listPurchaseOrders = defineTool({
  name: 'list_purchase_orders', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    status: z.preprocess(emptyToUndef, z.enum(STATUSES).optional()), supplierId: idOpt, materialId: idOpt, from: dateOpt, to: dateOpt,
  }),
  handler: async (ctx, input) => {
    const where: Prisma.PurchaseOrderWhereInput = {
      ...(input.status ? { status: input.status } : {}), ...(input.supplierId ? { supplierId: input.supplierId } : {}), ...(input.materialId ? { lines: { some: { materialId: input.materialId } } } : {}),
      ...(input.from || input.to ? { poDate: { ...(input.from ? { gte: istDate(input.from) } : {}), ...(input.to ? { lte: new Date(istDate(input.to).getTime() + 86_399_000) } : {}) } } : {}),
    };
    const rows = await ctx.db.purchaseOrder.findMany({ where, include: poInclude, orderBy: { createdAt: 'desc' }, take: MAX_ROWS });
    return { rows: rows.map(rowOf) };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'n', label: 'PO' }, { key: 's', label: 'Supplier' }, { key: 't', label: 'Total', align: 'right' }, { key: 'st', label: 'Status' }],
    rows: d.rows.slice(0, 10).map((r) => ({ n: r.number, s: r.supplier, t: inr(r.total), st: r.statusText })),
    note: d.rows.length === 0 ? 'There are no purchase orders.' : d.rows.length > 10 ? `Showing 10 of ${d.rows.length}.` : undefined,
  }],
});

// ── get_purchase_order ─────────────────────────────────────────────────────────────────────────────
export const getPurchaseOrder = defineTool({
  name: 'get_purchase_order', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ purchaseOrderId: idOpt, number: opt(40) }),
  handler: async (ctx, input) => {
    const ref = input.purchaseOrderId ?? input.number;
    if (!ref) throw new ToolError('NOT_FOUND', 'Which purchase order?', undefined, 'purchaseOrderId');
    const po = await findPo(ctx.db, ref);
    const receipts = await ctx.db.goodsReceipt.findMany({ where: { purchaseOrderId: po.id }, orderBy: { receiptDate: 'asc' }, select: { number: true, receiptDate: true } });
    return {
      po: rowOf(po), approved: po.approvedAt ? po.approvedAt.toISOString() : null,
      lines: po.lines.map((l) => ({
        id: l.id, materialId: l.materialId, material: l.material.name, unit: l.material.uom, ordered: Number(l.quantity), received: Number(l.receivedQty),
        due: Math.max(0, Number(l.quantity) - Number(l.receivedQty)), rate: Number(l.rate), amount: Number(l.amount),
      })),
      receipts: receipts.map((r) => ({ number: r.number, date: r.receiptDate.toISOString() })),
    };
  },
  view: (d) => [{
    kind: 'table', title: `${d.po.number} · ${d.po.supplier} · ${inr(d.po.total)} · ${d.po.statusText}`,
    columns: [{ key: 'm', label: 'Material' }, { key: 'o', label: 'Ordered', align: 'right' }, { key: 'r', label: 'Received', align: 'right' }, { key: 'rate', label: 'Rate', align: 'right' }],
    rows: d.lines.slice(0, 12).map((l) => ({ m: l.material, o: qty(l.ordered, l.unit), r: qty(l.received, l.unit), rate: rateText(l.rate, l.unit) })),
    note: d.po.job ? `For ${d.po.job}.` : undefined,
  }],
});

// ── get_purchase_price_history ─────────────────────────────────────────────────────────────────────
export const getPurchasePriceHistory = defineTool({
  name: 'get_purchase_price_history', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ materialId: idOpt, materialNames: z.array(z.string().max(100)).max(20).optional(), supplierId: idOpt, from: dateOpt, to: dateOpt }),
  handler: async (ctx, input) => {
    let materialIds: string[] | undefined = input.materialId ? [input.materialId] : undefined;
    const notFound: string[] = [];
    if (input.materialNames?.length) {
      const all = await ctx.db.material.findMany({ select: { id: true, name: true, nameKey: true } });
      materialIds = [...(materialIds ?? [])];
      for (const n of input.materialNames) {
        const exact = all.find((m) => m.nameKey === materialNameKey(n));
        const hits = exact ? [exact] : search(n, all, (m) => m.nameKey, (m) => m.name).slice(0, 3);
        if (!hits.length) notFound.push(n);
        materialIds.push(...hits.map((h) => h.id));
      }
    }
    const lines = await ctx.db.goodsReceiptLine.findMany({
      where: {
        acceptedQty: { gt: 0 }, ...(materialIds ? { materialId: { in: materialIds } } : {}),
        goodsReceipt: { ...(input.supplierId ? { supplierId: input.supplierId } : {}), ...(input.from || input.to ? { receiptDate: { ...(input.from ? { gte: istDate(input.from) } : {}), ...(input.to ? { lte: new Date(istDate(input.to).getTime() + 86_399_000) } : {}) } } : {}) },
      },
      include: { material: { select: { name: true, uom: true } }, goodsReceipt: { select: { receiptDate: true, supplier: { select: { name: true } }, purchaseOrder: { select: { poDate: true } } } } },
      orderBy: [{ goodsReceipt: { receiptDate: 'asc' } }, { goodsReceipt: { createdAt: 'asc' } }],
    });
    // previous rate = the receipt before it for the same material (any supplier): the rate "moved" from that
    const prev = new Map<string, number>();
    const rows = lines.map((l) => {
      const rate = Number(l.rate);
      const before = prev.get(l.materialId) ?? null;
      prev.set(l.materialId, rate);
      const lead = l.goodsReceipt.purchaseOrder ? Math.round((l.goodsReceipt.receiptDate.getTime() - l.goodsReceipt.purchaseOrder.poDate.getTime()) / 86_400_000) : null;
      return {
        materialId: l.materialId, date: l.goodsReceipt.receiptDate.toISOString(), material: l.material.name, unit: l.material.uom, supplier: l.goodsReceipt.supplier.name, rate,
        previousRate: before, changePct: before ? Math.round(((rate - before) / before) * 10_000) / 100 : null, leadTimeDays: lead !== null && lead >= 0 ? lead : null,
      };
    }).reverse().slice(0, 100);
    return { rows, notFound };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'd', label: 'Date' }, { key: 'm', label: 'Material' }, { key: 's', label: 'Supplier' }, { key: 'r', label: 'Rate', align: 'right' }, { key: 'c', label: 'Change', align: 'right' }],
    rows: d.rows.slice(0, 10).map((r) => ({ d: dateText(new Date(r.date)), m: r.material, s: r.supplier, r: rateText(r.rate, r.unit), c: r.changePct === null ? '–' : `${r.changePct > 0 ? '+' : ''}${r.changePct}%` })),
    note: d.rows.length === 0 ? (d.notFound.length ? `Couldn't find: ${d.notFound.join(', ')}. Check the spelling.` : 'No receipts yet.') : d.rows.length > 10 ? `Showing 10 of ${d.rows.length}.` : undefined,
  }],
});

