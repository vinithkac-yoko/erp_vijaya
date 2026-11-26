import { z } from 'zod';
import { materialNameKey } from '@/lib/names';
import { dateText, qty } from '@/lib/format';
import { search } from '@/lib/similar';
import { ToolError } from '../errors';
import { todayIST } from './counts';
import { defineTool } from './define';
import { flag, opt } from './helpers';
import { findParty } from './lookup';
import { notify, ownerIds } from './notifications';
import { nextNumber } from './numbers';
import { findPo, lastReceipt, PO_STATUS_TEXT, rateText } from './purchasing';

const WHOLE_UNITS = new Set(['NOS', 'SET']);
/// A receipt rate that moved more than this from the last receipt of that material is said aloud and the owner is told.
export const RATE_MOVE = 0.05;
const MAX_ROWS = 200;

const round2 = (n: number) => Math.round(n * 100) / 100;
const emptyToUndef = (v: unknown) => (v === '' || v === null ? undefined : v);
const validYmd = (s: string) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const dateOpt = z.preprocess(emptyToUndef, z.string().refine(validYmd, 'That is not a real date.').optional());
const istDate = (ymd: string) => new Date(`${ymd}T00:00:00+05:30`);
const idOpt = z.preprocess(emptyToUndef, z.string().min(1).max(64).optional());
const numeric = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/,/g, '')) : v === '' || v === null ? undefined : v);

const grnLine = z.object({
  materialId: z.string({ required_error: 'Choose the material.' }).min(1, 'Choose the material.').max(64),
  purchaseOrderLineId: idOpt,
  receivedQty: z.preprocess(numeric, z.number({ required_error: 'How much arrived?', invalid_type_error: 'Type the quantity as a number.' }).gt(0, 'The quantity must be more than zero.').max(1e9, 'That quantity is too big.')),
  acceptedQty: z.preprocess(numeric, z.number({ invalid_type_error: 'Type the accepted quantity as a number.' }).min(0, 'The accepted quantity cannot be less than zero.').max(1e9).optional()),
  rejectedQty: z.preprocess(numeric, z.number({ invalid_type_error: 'Type the rejected quantity as a number.' }).min(0, 'The rejected quantity cannot be less than zero.').max(1e9).optional()),
  rejectionReason: opt(200),
  rate: z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/[₹,\s]/g, '')) : v === '' || v === null ? undefined : v),
    z.number({ required_error: "Type the rate from the supplier's invoice.", invalid_type_error: 'Type the rate as a number.' }).gt(0, "Type the rate from the supplier's invoice. It can't be zero.").max(1e9, 'That rate is too big.')),
  hsnCode: opt(20),
  gstRate: z.preprocess(emptyToUndef, z.number({ invalid_type_error: 'Type the GST rate as a number.' }).min(0).max(100, 'A GST rate is between 0 and 100.').optional()),
});

/** The first day of this month in India: a receipt may be backdated within it, not before (BUSINESS_FLOW §10). */
const monthStart = (now: Date) => `${todayIST(now).slice(0, 7)}-01`;

// ── record_goods_receipt ───────────────────────────────────────────────────────────────────────────
export const recordGoodsReceipt = defineTool({
  name: 'record_goods_receipt', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    supplierId: idOpt, purchaseOrderId: idOpt, receiptDate: z.string({ required_error: 'Choose the date it arrived.' }).refine(validYmd, 'That is not a real date. Choose the date it arrived.'),
    supplierInvoiceNo: opt(60), supplierInvoiceDate: dateOpt, supplierDcNo: opt(60),
    lines: z.array(grnLine, { required_error: 'Add at least one material.' }).min(1, 'Add at least one material.').max(60, 'That is a lot of lines.'), confirmUnusual: flag.optional(),
  }),
  form: {
    title: 'Receive stock', verb: 'Add to stock',
    intro: 'Every delivery is checked: what arrived = what you accept + what you send back. Only what you accept goes into stock.',
    fields: [
      { name: 'purchaseOrderId', label: 'Against which purchase order? (leave empty for none)', type: 'purchaseOrder', pickerFilter: 'receivable' },
      { name: 'supplierId', label: 'Supplier', type: 'party', partyRole: 'SUPPLIER', required: true },
      { name: 'receiptDate', label: 'Date it arrived', type: 'date', required: true },
      { name: 'supplierInvoiceNo', label: "Supplier's invoice number", type: 'text' },
      { name: 'supplierInvoiceDate', label: 'Invoice date', type: 'date' },
      { name: 'supplierDcNo', label: 'Delivery challan number', type: 'text' },
      { name: 'lines', label: 'What arrived', type: 'grnLines', required: true },
    ],
  },
  stamp: 'STOCK RECEIVED',
  describe: (a) => [
    `${a.number} · ${a.supplier}`,
    ...((a.lines as { material: string; unit: string; received: number; accepted: number; rejected: number; reason: string | null; rate: number }[]) ?? []).map((l) =>
      `${l.material}: ${qty(l.received, l.unit)} arrived · ${qty(l.accepted, l.unit)} accepted${l.rejected > 0 ? ` · ${qty(l.rejected, l.unit)} sent back (${l.reason})` : ''} at ${rateText(l.rate, l.unit)}`),
    ...(a.invoiceNo ? [`Invoice ${a.invoiceNo}`] : []),
    ...(a.po ? [`Against ${a.po}: ${a.poStatus}`] : ['No purchase order: a direct receipt']),
  ],
  preview: async (ctx, input) => {
    const values: Record<string, unknown> = { receiptDate: todayIST() };
    const decorate: Record<string, unknown> = {};
    const info: string[] = [];
    if (typeof input.purchaseOrderId === 'string' && input.purchaseOrderId) {
      try {
        const po = await findPo(ctx.db, input.purchaseOrderId);
        values.purchaseOrderId = po.id; values.supplierId = po.supplierId;
        info.push(`${po.number} · ${po.supplier.name} · ${PO_STATUS_TEXT[po.status]}`);
        if (po.status === 'PENDING_APPROVAL' || po.status === 'DRAFT') info.push('This PO is still waiting for the owner. You can receive against it, but you will be asked to say you know.');
        if (['CANCELLED', 'REJECTED', 'RECEIVED'].includes(po.status)) info.push(`This PO is ${PO_STATUS_TEXT[po.status].toLowerCase()}.`);
        const due = po.lines.map((l) => ({ line: l, due: Math.max(0, Number(l.quantity) - Number(l.receivedQty)) }));
        const asked = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : null;
        const rows = (asked ?? due.filter((d) => d.due > 0).map((d) => ({ materialId: d.line.materialId, purchaseOrderLineId: d.line.id, receivedQty: d.due }))).map((r) => {
          const hit = due.find((d) => d.line.id === r.purchaseOrderLineId) ?? due.find((d) => d.line.materialId === r.materialId);
          // the PO's rate is only a hint beside the empty rate box: the rate comes from the supplier's invoice
          return hit ? { ...r, purchaseOrderLineId: hit.line.id, poRate: Number(hit.line.rate), due: hit.due, unit: hit.line.material.uom } : r;
        });
        decorate.lines = rows;
      } catch (e) { info.push(e instanceof ToolError ? e.message : 'Choose the purchase order.'); }
    }
    return { info, values, decorate };
  },
  handler: async (ctx, input) => {
    const today = todayIST(ctx.now);
    if (input.receiptDate > today) throw new ToolError('RECEIPT_IN_FUTURE', "A receipt can't be dated in the future.", undefined, 'receiptDate');
    if (input.receiptDate < monthStart(ctx.now)) throw new ToolError('RECEIPT_TOO_OLD', `A receipt can't be dated before ${dateText(istDate(monthStart(ctx.now)))}. Record it with this month's date and the invoice date as it is.`, undefined, 'receiptDate');

    const po = input.purchaseOrderId ? await findPo(ctx.db, input.purchaseOrderId) : null;
    const supplier = await findParty(ctx.db, { id: input.supplierId ?? po?.supplierId }, 'SUPPLIER');
    if (po) {
      if (po.supplierId !== supplier.id) throw new ToolError('SUPPLIER_MISMATCH', `${po.number} is to ${po.supplier.name}, not ${supplier.name}.`, undefined, 'supplierId');
      if (po.status === 'CANCELLED' || po.status === 'REJECTED') throw new ToolError('PO_CLOSED', `${po.number} is ${PO_STATUS_TEXT[po.status].toLowerCase()}, so nothing can be received against it.`, undefined, 'purchaseOrderId');
      if (po.status === 'RECEIVED') throw new ToolError('PO_CLOSED', `${po.number} has been received in full already.`, undefined, 'purchaseOrderId');
      if ((po.status === 'PENDING_APPROVAL' || po.status === 'DRAFT') && !input.confirmUnusual) {
        throw new ToolError('CONFIRM_PO_NOT_APPROVED', `${po.number} is still waiting for the owner to approve it. Has the material really arrived?`, undefined, 'purchaseOrderId');
      }
    }

    const mats = await ctx.db.material.findMany({ where: { id: { in: input.lines.map((l) => l.materialId) } } });
    const byId = new Map(mats.map((m) => [m.id, m]));
    const used = new Set<string>();
    const rateMoves: { material: string; from: number; to: number; pct: number; unit: string }[] = [];
    const prepared = [];
    for (const l of input.lines) {
      const m = byId.get(l.materialId);
      if (!m || !m.isActive) throw new ToolError('NOT_FOUND', "One of those materials couldn't be found.", undefined, 'lines');
      const received = l.receivedQty;
      const rejected = l.rejectedQty ?? (l.acceptedQty !== undefined ? round4(received - l.acceptedQty) : 0);
      const accepted = l.acceptedQty ?? round4(received - rejected);
      if (WHOLE_UNITS.has(m.uom) && ![received, accepted, rejected].every(Number.isInteger)) throw new ToolError('INVALID_QUANTITY', `${m.name} is received in whole pieces.`, undefined, 'lines');
      if (round4(accepted + rejected) !== round4(received)) {
        throw new ToolError('GRN_SPLIT_MISMATCH', `${m.name}: ${qty(received, m.uom)} arrived, but accepted ${qty(accepted, m.uom)} + rejected ${qty(rejected, m.uom)} makes ${qty(round4(accepted + rejected), m.uom)}. Correct the numbers.`, undefined, 'lines');
      }
      if (rejected > 0 && !l.rejectionReason) throw new ToolError('REJECTION_REASON_REQUIRED', `${m.name}: say why ${qty(rejected, m.uom)} is sent back.`, undefined, 'lines');
      let poLine = null;
      if (po) {
        poLine = (l.purchaseOrderLineId ? po.lines.find((x) => x.id === l.purchaseOrderLineId) : po.lines.find((x) => x.materialId === m.id && !used.has(x.id))) ?? null;
        if (l.purchaseOrderLineId && (!poLine || poLine.materialId !== m.id)) throw new ToolError('NOT_FOUND', `${m.name} isn't on ${po.number}.`, undefined, 'lines');
        if (poLine) used.add(poLine.id);
      }
      const last = await lastReceipt(ctx.db, m.id);
      if (last && Math.abs(l.rate - last.rate) / last.rate > RATE_MOVE) {
        rateMoves.push({ material: m.name, from: last.rate, to: l.rate, pct: Math.round(((l.rate - last.rate) / last.rate) * 1000) / 10, unit: m.uom });
      }
      prepared.push({ m, received, accepted, rejected, reason: rejected > 0 ? l.rejectionReason ?? null : null, rate: l.rate, hsn: l.hsnCode, gst: l.gstRate, poLine, amount: round2(accepted * l.rate) });
    }

    const receiptDate = istDate(input.receiptDate);
    const grn = await ctx.db.goodsReceipt.create({
      data: {
        number: await nextNumber(ctx.db, 'GRN', receiptDate), supplierId: supplier.id, purchaseOrderId: po?.id, receiptDate,
        supplierInvoiceNo: input.supplierInvoiceNo, supplierInvoiceDate: input.supplierInvoiceDate ? istDate(input.supplierInvoiceDate) : null, supplierDcNo: input.supplierDcNo,
      },
    });
    const who = { actorType: ctx.actor.actorType, actorId: ctx.actor.actorId, agentRunId: ctx.actor.agentRunId, toolName: ctx.actor.toolName };
    for (const p of prepared) {
      const line = await ctx.db.goodsReceiptLine.create({
        data: { goodsReceiptId: grn.id, purchaseOrderLineId: p.poLine?.id, materialId: p.m.id, receivedQty: p.received, acceptedQty: p.accepted, rejectedQty: p.rejected, rejectionReason: p.reason, rate: p.rate, hsnCode: p.hsn, gstRate: p.gst, amount: p.amount },
      });
      // The ledger shows what happened: everything that arrived comes in, and what failed inspection goes back out (BUSINESS_FLOW §10).
      await ctx.db.stockMovement.create({ data: { materialId: p.m.id, type: 'RECEIPT', direction: 'IN', quantity: p.received, rate: p.rate, grnLineId: line.id, movementDate: receiptDate, ...who } });
      if (p.rejected > 0) await ctx.db.stockMovement.create({ data: { materialId: p.m.id, type: 'REJECT_RETURN', direction: 'OUT', quantity: p.rejected, rate: p.rate, grnLineId: line.id, movementDate: receiptDate, reasonCode: null, notes: p.reason, ...who } });
      if (p.poLine) await ctx.db.purchaseOrderLine.update({ where: { id: p.poLine.id }, data: { receivedQty: { increment: p.accepted } } });
    }

    let poStatus: string | null = null;
    if (po) {
      const fresh = await ctx.db.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
      const full = fresh.every((l) => Number(l.receivedQty) >= Number(l.quantity));
      const some = fresh.some((l) => Number(l.receivedQty) > 0);
      // a PO the owner has not approved yet stays that way: he can still approve or reject it
      const next = po.status === 'PENDING_APPROVAL' || po.status === 'DRAFT' ? po.status : full ? 'RECEIVED' : some ? 'PARTIALLY_RECEIVED' : po.status;
      if (next !== po.status) await ctx.db.purchaseOrder.update({ where: { id: po.id }, data: { status: next } });
      poStatus = PO_STATUS_TEXT[next].toLowerCase();
      if (po.status === 'PENDING_APPROVAL') {
        await notify(ctx.db, await ownerIds(ctx.db), { type: 'PO_PENDING_APPROVAL', title: 'Material arrived before approval', body: `Material has come against ${po.number} (${po.supplier.name}), which is still waiting for you.`, entityType: 'PurchaseOrder', entityId: po.id }, ctx.session.userId);
      }
    }
    if (rateMoves.length) {
      await notify(ctx.db, await ownerIds(ctx.db), {
        type: 'RATE_CHANGE', title: 'A rate moved', body: `${grn.number} from ${supplier.name}: ${rateMoves.map((r) => `${r.material} ${rateText(r.to, r.unit)}, was ${rateText(r.from, r.unit)} (${r.pct > 0 ? '+' : ''}${r.pct}%)`).join('; ')}.`, entityType: 'GoodsReceipt', entityId: grn.id,
      }, ctx.session.userId);
    }

    const shown = prepared.map((p) => ({ material: p.m.name, unit: p.m.uom, received: p.received, accepted: p.accepted, rejected: p.rejected, reason: p.reason, rate: p.rate, amount: p.amount }));
    return {
      data: { id: grn.id, number: grn.number, supplier: supplier.name, lines: shown, rateMoves, po: po?.number ?? null, poJobId: po?.triggeredByJobId ?? null, poStatus },
      audit: {
        entityType: 'GoodsReceipt', entityId: grn.id, action: 'CREATE',
        after: { number: grn.number, supplier: supplier.name, lines: shown, invoiceNo: input.supplierInvoiceNo ?? null, po: po?.number ?? null, poStatus, rateMoves },
      },
    };
  },
  followUps: async (ctx, _input, result) => {
    const r = result as { lines: { material: string; unit: string; rejected: number; reason: string | null }[]; rateMoves: { material: string; from: number; to: number; pct: number; unit: string }[]; poJobId: string | null };
    const facts: string[] = [];
    for (const m of r.rateMoves) facts.push(`${m.material} was received at ${rateText(m.to, m.unit)}, ${m.pct > 0 ? 'up' : 'down'} ${Math.abs(m.pct)}% from the last receipt (${rateText(m.from, m.unit)}). The owner has been told.`);
    for (const l of r.lines.filter((x) => x.rejected > 0)) facts.push(`${qty(l.rejected, l.unit)} of ${l.material} goes back to the supplier (${l.reason}).`);
    const chips = [];
    if (r.poJobId) {
      const sh = await ctx.read('check_job_shortage', { jobId: r.poJobId });
      if (sh.ok && !(sh.data as { anyShort: boolean; hasBom: boolean }).anyShort && (sh.data as { hasBom: boolean }).hasBom) {
        const d = sh.data as { jobId: string; number: string };
        facts.push(`With this, ${d.number} is no longer short of anything.`);
        chips.push({ label: `Issue material to ${d.number}`, form: 'issue_material', prefill: { jobId: d.jobId } });
      }
    }
    return { facts, chips };
  },
});
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

// ── list_goods_receipts ────────────────────────────────────────────────────────────────────────────
export const listGoodsReceipts = defineTool({
  name: 'list_goods_receipts', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ supplierId: idOpt, purchaseOrderId: idOpt, materialNames: z.array(z.string().max(100)).max(20).optional(), from: dateOpt, to: dateOpt }),
  handler: async (ctx, input) => {
    let poId = input.purchaseOrderId;
    if (poId) poId = (await findPo(ctx.db, poId)).id;
    let materialIds: string[] | undefined;
    if (input.materialNames?.length) {
      const all = await ctx.db.material.findMany({ select: { id: true, name: true, nameKey: true } });
      materialIds = [];
      for (const n of input.materialNames) {
        const exact = all.find((m) => m.nameKey === materialNameKey(n));
        materialIds.push(...(exact ? [exact] : search(n, all, (m) => m.nameKey, (m) => m.name).slice(0, 3)).map((m) => m.id));
      }
    }
    const lines = await ctx.db.goodsReceiptLine.findMany({
      where: {
        ...(materialIds ? { materialId: { in: materialIds } } : {}),
        goodsReceipt: { ...(input.supplierId ? { supplierId: input.supplierId } : {}), ...(poId ? { purchaseOrderId: poId } : {}), ...(input.from || input.to ? { receiptDate: { ...(input.from ? { gte: istDate(input.from) } : {}), ...(input.to ? { lte: new Date(istDate(input.to).getTime() + 86_399_000) } : {}) } } : {}) },
      },
      include: { material: { select: { name: true, uom: true } }, goodsReceipt: { select: { id: true, number: true, receiptDate: true, supplierInvoiceNo: true, purchaseOrderId: true, purchaseOrder: { select: { number: true } }, supplier: { select: { name: true } } } } },
      orderBy: [{ goodsReceipt: { receiptDate: 'desc' } }, { goodsReceipt: { createdAt: 'desc' } }], take: MAX_ROWS,
    });
    return {
      rows: lines.map((l) => ({
        id: l.goodsReceipt.id, purchaseOrderId: l.goodsReceipt.purchaseOrderId, number: l.goodsReceipt.number, date: l.goodsReceipt.receiptDate.toISOString(), supplier: l.goodsReceipt.supplier.name,
        po: l.goodsReceipt.purchaseOrder?.number ?? null, invoiceNo: l.goodsReceipt.supplierInvoiceNo, material: l.material.name, unit: l.material.uom,
        receivedQty: Number(l.receivedQty), acceptedQty: Number(l.acceptedQty), rejectedQty: Number(l.rejectedQty), rejectionReason: l.rejectionReason, rate: Number(l.rate),
      })),
    };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'd', label: 'Date' }, { key: 'n', label: 'Receipt' }, { key: 'm', label: 'Material' }, { key: 'a', label: 'Accepted', align: 'right' }, { key: 'r', label: 'Sent back', align: 'right' }, { key: 'rate', label: 'Rate', align: 'right' }],
    rows: d.rows.slice(0, 10).map((r) => ({ d: dateText(new Date(r.date)), n: r.number, m: r.material, a: qty(r.acceptedQty, r.unit), r: r.rejectedQty > 0 ? qty(r.rejectedQty, r.unit) : '–', rate: rateText(r.rate, r.unit) })),
    note: d.rows.length === 0 ? 'There are no receipts.' : d.rows.length > 10 ? `Showing 10 of ${d.rows.length}.` : undefined,
  }],
});

