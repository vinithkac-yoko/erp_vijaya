import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pendingActions, registry, runTool } from '@/server/tools';
import { balance, prisma, resetDb } from './helpers/db';
import { sendOwnerEmails, sentMail } from '@/server/tools/email';
import { fails, material, ok, owner, save, seedSettings, storekeeper } from './helpers/tools';

beforeEach(async () => { await resetDb(); await seedSettings(); });
afterAll(() => prisma.$disconnect());

type S = Awaited<ReturnType<typeof storekeeper>>;
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
type Rows<T = Record<string, unknown>> = { rows: T[] };
const party = async (s: S, name: string, role: 'SUPPLIER' | 'CUSTOMER' = 'SUPPLIER') => (await ok<{ id: string }>(save(s, 'create_party', { name, role, city: 'Chennai' }))).id;
const mat = async (s: S, name: string, uom: string, over: Record<string, unknown> = {}) => (await ok<{ id: string }>(save(s, 'create_material', material(name, { uom, ...over })))).id;
const po = (s: S, supplierId: string, lines: { materialId: string; quantity: number; rate?: number }[], over: Record<string, unknown> = {}) =>
  save(s, 'create_purchase_order', { supplierId, lines, ...over });
async function setup(s: S) {
  const sundaram = await party(s, 'Sundaram Ferrites'); const ravi = await party(s, 'Ravi Insulation Traders'); const copper = await party(s, 'Chennai Copper Wires');
  const core = await mat(s, 'Ferrite Core E-30', 'NOS', { stockType: 'STANDING', minimumLevel: 50 }); const tape = await mat(s, 'Insulation Tape', 'MTR'); const wire = await mat(s, '22 SWG Copper Wire', 'KG');
  return { sundaram, ravi, copper, core, tape, wire };
}
const receipt = (s: S, supplierId: string, lines: Record<string, unknown>[], over: Record<string, unknown> = {}) =>
  save(s, 'record_goods_receipt', { supplierId, receiptDate: today(), lines, ...over });

describe('purchase orders and the approval limit (ACCEPTANCE §5)', () => {
  it('₹63,830 is above ₹50,000: it waits for the owner, who is told; the storekeeper is told which happened (5.4)', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    const r = await ok<{ number: string; total: number; status: string }>(po(s, x.sundaram, [{ materialId: x.core, quantity: 982, rate: 65 }]));
    expect(r).toMatchObject({ total: 63830, status: 'PENDING_APPROVAL' });
    expect(r.number).toMatch(/^PO-\d{4}-0001$/);
    const n = await prisma.notification.findMany({ where: { userId: o.userId } });
    expect(n).toMatchObject([{ type: 'PO_PENDING_APPROVAL', body: expect.stringContaining('₹63,830') }]);
    expect(await prisma.notification.count({ where: { userId: s.userId } })).toBe(0);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'create_purchase_order' } });
    expect(ev.afterJson).toMatchObject({ status: 'PENDING_APPROVAL', limit: 50000, supplier: 'Sundaram Ferrites' });
  });

  it('₹1,500 and ₹40,600 are within the limit: approved at once (5.5, 5.7); exactly at the limit is approved (24.17)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    expect(await ok(po(s, x.ravi, [{ materialId: x.tape, quantity: 500, rate: 3 }]))).toMatchObject({ total: 1500, status: 'APPROVED' });
    expect(await ok(po(s, x.copper, [{ materialId: x.wire, quantity: 50, rate: 812 }]))).toMatchObject({ total: 40600, status: 'APPROVED' });
    expect(await ok(po(s, x.copper, [{ materialId: x.wire, quantity: 100, rate: 500 }]))).toMatchObject({ total: 50000, status: 'APPROVED' });
    expect(await ok(po(s, x.copper, [{ materialId: x.wire, quantity: 1, rate: 50001 }]))).toMatchObject({ status: 'PENDING_APPROVAL' });
  });

  it('never makes up a rate, and never an empty PO (5.2, 5.6, 5.8)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    const noRate = await fails(po(s, x.copper, [{ materialId: x.wire, quantity: 50 }]));
    expect(noRate).toMatchObject({ code: 'INVALID_INPUT', message: "Type the rate from the supplier's quote." });
    expect((await fails(po(s, x.sundaram, []))).message).toBe('Add at least one material.');
    expect((await fails(po(s, x.sundaram, [{ materialId: x.core, quantity: 0, rate: 65 }]))).message).toBe('The quantity must be more than zero.');
    expect(await prisma.purchaseOrder.count()).toBe(0);
    // the assistant cannot put a rate in a form either: it is dropped when the form opens
    const opened = await pendingActions.create(s, { tool: 'create_purchase_order', origin: 'AGENT', input: { supplierName: 'Sundaram Ferrites', lines: [{ materialId: x.core, quantity: 982, rate: 65 }] } });
    if (!opened.ok) throw new Error('did not open');
    expect(opened.data.dropped).toContain('lines[0].rate');
    expect(opened.data.input).toMatchObject({ lines: [{ materialId: x.core, quantity: 982 }] });
  });

  it('a supplier is picked, never created here; a customer is not a supplier; the name works for the assistant', async () => {
    const s = await storekeeper(); const x = await setup(s); const cust = await party(s, 'Ashok Transformers', 'CUSTOMER');
    expect((await fails(po(s, cust, [{ materialId: x.core, quantity: 5, rate: 1 }]))).code).toBe('PARTY_WRONG_ROLE');
    expect((await fails(save(s, 'create_purchase_order', { supplierName: 'Nobody Traders', lines: [{ materialId: x.core, quantity: 5, rate: 1 }] }))).code).toBe('PARTY_NOT_FOUND');
    await ok(save(s, 'create_purchase_order', { supplierName: 'Sundaram Ferrites', lines: [{ materialId: x.core, quantity: 5, rate: 1 }] }));
    expect(await prisma.party.count()).toBe(4);
  });

  it('a rate far from the last one paid is asked about once (24.11)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    await ok(receipt(s, x.copper, [{ materialId: x.wire, receivedQty: 10, rate: 812 }]));
    const f = await fails(po(s, x.copper, [{ materialId: x.wire, quantity: 5, rate: 8.12 }]));
    expect(f).toMatchObject({ code: 'CONFIRM_UNUSUAL_RATE', field: 'lines' });
    expect(f.message).toContain('far below the last rate paid (₹812/kg)');
    await ok(po(s, x.copper, [{ materialId: x.wire, quantity: 5, rate: 8.12 }], { confirmUnusual: true }));
    await ok(po(s, x.copper, [{ materialId: x.wire, quantity: 5, rate: 840 }])); // a normal move is not asked about
  });

  it('GST adds to the total the limit is compared with', async () => {
    const s = await storekeeper(); const x = await setup(s);
    const r = await ok<{ total: number; status: string }>(save(s, 'create_purchase_order', { supplierId: x.copper, lines: [{ materialId: x.wire, quantity: 60, rate: 800, gstRate: 18 }] }));
    expect(r).toMatchObject({ total: 56640, status: 'PENDING_APPROVAL' }); // 48,000 + 8,640 GST
  });

  it('the storekeeper cannot approve or reject, whatever he says (5.9, 5.10)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    await ok(po(s, x.sundaram, [{ materialId: x.core, quantity: 982, rate: 65 }]));
    expect((await fails(save(s, 'approve_purchase_order', {}))).code).toBe('FORBIDDEN_ROLE');
    expect((await fails(save(s, 'reject_purchase_order', { reason: 'x' }))).code).toBe('FORBIDDEN_ROLE');
    expect((await prisma.purchaseOrder.findFirstOrThrow()).status).toBe('PENDING_APPROVAL');
  });

  it('the owner approves, and the storekeeper is told (5.14, 5.16)', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    await ok(po(s, x.sundaram, [{ materialId: x.core, quantity: 982, rate: 65 }]));
    const waiting = await ok<{ purchaseOrders: { number: string; total: number }[] }>(runTool(o, 'list_pending_approvals', {}));
    expect(waiting.purchaseOrders).toMatchObject([{ total: 63830 }]);
    await ok(save(o, 'approve_purchase_order', {}));
    expect(await prisma.purchaseOrder.findFirstOrThrow()).toMatchObject({ status: 'APPROVED', approvedById: o.userId });
    expect(await prisma.notification.findMany({ where: { userId: s.userId } })).toMatchObject([{ type: 'PO_APPROVED' }]);
    expect((await fails(save(o, 'approve_purchase_order', {}))).code).toBe('NOT_FOUND'); // nothing is waiting any more
  });

  it('the owner rejects with a reason the storekeeper reads; no stock moves (5.17)', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    await ok(po(s, x.sundaram, [{ materialId: x.core, quantity: 982, rate: 65 }]));
    expect((await fails(save(o, 'reject_purchase_order', {}))).message).toBe('Say why.');
    await ok(save(o, 'reject_purchase_order', { reason: 'The rate is too high' }));
    expect(await prisma.purchaseOrder.findFirstOrThrow()).toMatchObject({ status: 'REJECTED', rejectionReason: 'The rate is too high' });
    expect((await prisma.notification.findFirstOrThrow({ where: { userId: s.userId } })).body).toContain('The rate is too high');
    expect(await prisma.stockMovement.count()).toBe(0);
  });

  it('the limit is the owner\'s setting, read every time; a missing one is an error, not a made-up number (5.18–5.21)', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    await ok(save(o, 'update_setting', { key: 'po.approval_limit', value: 75000 }));
    expect(await ok(po(s, x.sundaram, [{ materialId: x.core, quantity: 1000, rate: 70 }]))).toMatchObject({ total: 70000, status: 'APPROVED' });
    await ok(save(o, 'update_setting', { key: 'po.approval_limit', value: 50000 }));
    expect(await ok(po(s, x.sundaram, [{ materialId: x.core, quantity: 1000, rate: 70 }]))).toMatchObject({ status: 'PENDING_APPROVAL' });
    await prisma.setting.deleteMany({ where: { key: 'po.approval_limit' } });
    expect((await fails(po(s, x.sundaram, [{ materialId: x.core, quantity: 1, rate: 1 }]))).code).toBe('SETTING_MISSING');
  });

  it('an approved PO cannot be edited; it can be cancelled while nothing has come (5.11, 5.12)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    const a = await ok<{ id: string }>(po(s, x.ravi, [{ materialId: x.tape, quantity: 500, rate: 3 }]));
    expect(registry.get('update_purchase_order')).toBeUndefined();
    expect((await fails(save(s, 'cancel_purchase_order', { purchaseOrderId: a.id }))).message).toBe('Say why.');
    await ok(save(s, 'cancel_purchase_order', { purchaseOrderId: a.id, reason: 'Wrong quantity' }));
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('CANCELLED');
    expect((await fails(save(s, 'cancel_purchase_order', { purchaseOrderId: a.id, reason: 'again' }))).code).toBe('PO_ALREADY_CANCELLED');
  });

  it('lists and shows POs, found by number or its end (5.13)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    const a = await ok<{ number: string }>(po(s, x.ravi, [{ materialId: x.tape, quantity: 500, rate: 3 }]));
    await ok(po(s, x.sundaram, [{ materialId: x.core, quantity: 982, rate: 65 }]));
    const all = await ok<Rows<{ status: string }>>(runTool(s, 'list_purchase_orders', {}));
    expect(all.rows.map((r) => r.status).sort()).toEqual(['APPROVED', 'PENDING_APPROVAL']);
    expect((await ok<Rows>(runTool(s, 'list_purchase_orders', { status: 'APPROVED' }))).rows).toHaveLength(1);
    for (const ref of [a.number, '1']) {
      const g = await ok<{ po: { number: string }; lines: { material: string; ordered: number; due: number }[] }>(runTool(s, 'get_purchase_order', { number: ref }));
      expect(g.po.number).toBe(a.number);
      expect(g.lines[0]).toMatchObject({ material: 'Insulation Tape', ordered: 500, due: 500 });
    }
  });
});

describe('goods receipt with inspection (ACCEPTANCE §6)', () => {
  it('against an approved PO: all 982 good, stock now 982 (+ the 18 already there = 1000), the PO is received (6.1, 6.2, 6.10)', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    await ok(receipt(s, x.sundaram, [{ materialId: x.core, receivedQty: 18, rate: 65 }])); // the 18 cores that were already there
    const p = await ok<{ id: string }>(po(s, x.sundaram, [{ materialId: x.core, quantity: 982, rate: 65 }]));
    await ok(save(o, 'approve_purchase_order', {}));
    const g = await ok<{ number: string; poStatus: string }>(receipt(s, x.sundaram, [{ materialId: x.core, purchaseOrderLineId: (await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: p.id } })).id, receivedQty: 982, rate: 65 }], { purchaseOrderId: p.id, supplierInvoiceNo: 'SF/2627/0441', supplierInvoiceDate: today() }));
    expect(g.poStatus).toBe('received');
    expect(await balance(x.core)).toMatchObject({ qty: 1000 });
    const grn = await prisma.goodsReceipt.findFirstOrThrow({ where: { purchaseOrderId: p.id } });
    expect(grn).toMatchObject({ supplierInvoiceNo: 'SF/2627/0441' });
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ status: 'RECEIVED' });
    expect(Number((await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: p.id } })).receivedQty)).toBe(982);
  });

  it('50 kg arrive, 3 damaged and sent back: stock +47 only, both movements are in the ledger (6.3)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    const r = await ok<{ lines: { accepted: number; rejected: number }[] }>(receipt(s, x.copper, [{ materialId: x.wire, receivedQty: 50, rejectedQty: 3, rejectionReason: 'Damaged in transit', rate: 812 }]));
    expect(r.lines[0]).toMatchObject({ accepted: 47, rejected: 3 });
    expect(await balance(x.wire)).toMatchObject({ qty: 47, rate: 812 });
    const mv = await prisma.stockMovement.findMany({ where: { materialId: x.wire }, orderBy: { createdAt: 'asc' } });
    expect(mv.map((m) => [m.type, m.direction, Number(m.quantity)])).toEqual([['RECEIPT', 'IN', 50], ['REJECT_RETURN', 'OUT', 3]]);
    expect(mv[1]?.notes).toBe('Damaged in transit');
    expect(Number((await prisma.goodsReceiptLine.findFirstOrThrow()).acceptedQty)).toBe(47);
  });

  it('50 = 45 + 3 is refused; a rejection needs its reason; the rate is never guessed (6.4, 6.9)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    const mism = await fails(receipt(s, x.copper, [{ materialId: x.wire, receivedQty: 50, acceptedQty: 45, rejectedQty: 3, rejectionReason: 'x', rate: 812 }]));
    expect(mism).toMatchObject({ code: 'GRN_SPLIT_MISMATCH', field: 'lines' });
    expect(mism.message).toContain('makes 48 kg');
    expect((await fails(receipt(s, x.copper, [{ materialId: x.wire, receivedQty: 50, rejectedQty: 3, rate: 812 }]))).code).toBe('REJECTION_REASON_REQUIRED');
    expect((await fails(receipt(s, x.sundaram, [{ materialId: x.core, receivedQty: 50 }]))).message).toBe("Type the rate from the supplier's invoice.");
    expect(await prisma.goodsReceipt.count()).toBe(0);
    expect(await prisma.stockMovement.count()).toBe(0);
  });

  it('a partial delivery leaves the PO open as partly received; the rest completes it (6.5, 6.6)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    const p = await ok<{ id: string }>(po(s, x.ravi, [{ materialId: x.tape, quantity: 500, rate: 3 }]));
    const first = await ok<{ poStatus: string }>(receipt(s, x.ravi, [{ materialId: x.tape, receivedQty: 300, rate: 3 }], { purchaseOrderId: p.id }));
    expect(first.poStatus).toBe('partly received');
    expect((await ok<{ lines: { due: number }[] }>(runTool(s, 'get_purchase_order', { purchaseOrderId: p.id }))).lines[0]?.due).toBe(200);
    expect((await fails(save(s, 'cancel_purchase_order', { purchaseOrderId: p.id, reason: 'x' }))).code).toBe('PO_HAS_RECEIPTS');
    expect((await ok<{ poStatus: string }>(receipt(s, x.ravi, [{ materialId: x.tape, receivedQty: 200, rate: 3 }], { purchaseOrderId: p.id }))).poStatus).toBe('received');
    expect((await fails(receipt(s, x.ravi, [{ materialId: x.tape, receivedQty: 1, rate: 3 }], { purchaseOrderId: p.id }))).code).toBe('PO_CLOSED');
    expect(await balance(x.tape)).toMatchObject({ qty: 500 });
  });

  it('a direct receipt with no PO is allowed; a rate that jumps more than 5% is said and the owner is told (6.7)', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    await ok(receipt(s, x.copper, [{ materialId: x.wire, receivedQty: 50, rate: 812 }]));
    const r = await ok<{ rateMoves: { material: string; from: number; to: number; pct: number }[]; po: string | null }>(receipt(s, x.copper, [{ materialId: x.wire, receivedQty: 20, rate: 845 }]));
    expect(r.po).toBeNull();
    expect(r.rateMoves).toEqual([]); // 812 to 845 is 4.1%: under 5%, so not said
    const big = await ok<{ rateMoves: { pct: number }[] }>(receipt(s, x.copper, [{ materialId: x.wire, receivedQty: 10, rate: 900 }]));
    expect(big.rateMoves).toMatchObject([{ from: 845, to: 900, pct: 6.5 }]);
    expect(await prisma.notification.findMany({ where: { userId: o.userId, type: 'RATE_CHANGE' } })).toMatchObject([{ body: expect.stringContaining('₹900/kg, was ₹845/kg (+6.5%)') }]);
    expect(await balance(x.wire)).toMatchObject({ qty: 80 });
  });

  it('material arriving for a PO still waiting for the owner needs a yes, and the PO stays waiting (6.8)', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    const p = await ok<{ id: string }>(po(s, x.sundaram, [{ materialId: x.core, quantity: 982, rate: 65 }]));
    const f = await fails(receipt(s, x.sundaram, [{ materialId: x.core, receivedQty: 982, rate: 65 }], { purchaseOrderId: p.id }));
    expect(f.code).toBe('CONFIRM_PO_NOT_APPROVED');
    expect(await prisma.goodsReceipt.count()).toBe(0);
    await ok(receipt(s, x.sundaram, [{ materialId: x.core, receivedQty: 982, rate: 65 }], { purchaseOrderId: p.id, confirmUnusual: true }));
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('PENDING_APPROVAL');
    expect(await prisma.notification.count({ where: { userId: o.userId, title: 'Material arrived before approval' } })).toBe(1);
    await ok(save(o, 'approve_purchase_order', { purchaseOrderId: p.id })); // approving afterwards follows what has arrived
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('RECEIVED');
  });

  it('refuses a future date, a date before this month, the wrong supplier, and a material that is not on the PO', async () => {
    const s = await storekeeper(); const x = await setup(s);
    const p = await ok<{ id: string }>(po(s, x.ravi, [{ materialId: x.tape, quantity: 500, rate: 3 }]));
    expect((await fails(receipt(s, x.ravi, [{ materialId: x.tape, receivedQty: 5, rate: 3 }], { receiptDate: '2099-01-01' }))).code).toBe('RECEIPT_IN_FUTURE');
    expect((await fails(receipt(s, x.ravi, [{ materialId: x.tape, receivedQty: 5, rate: 3 }], { receiptDate: '2020-01-01' }))).code).toBe('RECEIPT_TOO_OLD');
    expect((await fails(receipt(s, x.sundaram, [{ materialId: x.tape, receivedQty: 5, rate: 3 }], { purchaseOrderId: p.id }))).code).toBe('SUPPLIER_MISMATCH');
    const line = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: p.id } });
    expect((await fails(receipt(s, x.ravi, [{ materialId: x.core, purchaseOrderLineId: line.id, receivedQty: 5, rate: 3 }], { purchaseOrderId: p.id }))).code).toBe('NOT_FOUND');
    expect((await fails(receipt(s, x.ravi, [{ materialId: x.core, receivedQty: 2.5, rate: 3 }]))).code).toBe('INVALID_QUANTITY');
  });

  it('price history shows each receipt rate, the move from the one before, and the lead time (PO date to receipt)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    await ok(receipt(s, x.copper, [{ materialId: x.wire, receivedQty: 50, rate: 800 }]));
    await ok(receipt(s, x.copper, [{ materialId: x.wire, receivedQty: 50, rate: 840 }]));
    const h = await ok<Rows<{ rate: number; previousRate: number | null; changePct: number | null }>>(runTool(s, 'get_purchase_price_history', { materialNames: ['22 swg copper wire'] }));
    expect(h.rows.map((r) => [r.rate, r.previousRate, r.changePct])).toEqual([[840, 800, 5], [800, null, null]]);
    const l = await ok<Rows<{ receivedQty: number }>>(runTool(s, 'list_goods_receipts', { materialNames: ['22 SWG Copper Wire'] }));
    expect(l.rows).toHaveLength(2);
  });

  it('the follow-up after a receipt that completes a job\'s shortage offers to issue to that job', async () => {
    const s = await storekeeper(); const x = await setup(s);
    const cust = await party(s, 'Ashok Transformers', 'CUSTOMER');
    const job = await ok<{ id: string; number: string }>(save(s, 'create_job', { customerId: cust, productDescription: 'SMPS', quantity: 500, jobDate: today() }));
    await ok(save(s, 'set_job_bom', { jobId: job.id, lines: [{ materialId: x.core, qtyPerPiece: 2 }] }));
    const p = await ok<{ id: string }>(po(s, x.sundaram, [{ materialId: x.core, quantity: 1000, rate: 40 }], { triggeredByJobId: job.id }));
    const g = await ok<Record<string, unknown>>(receipt(s, x.sundaram, [{ materialId: x.core, receivedQty: 1000, rate: 40 }], { purchaseOrderId: p.id }));
    const tool = registry.get('record_goods_receipt');
    if (!tool || tool.kind !== 'write' || !tool.followUps) throw new Error('no follow-ups');
    const f = await tool.followUps({ session: s, read: (n, i) => runTool(s, n, i) }, {}, g);
    expect(f.chips).toMatchObject([{ label: `Issue material to ${job.number}`, form: 'issue_material', prefill: { jobId: job.id } }]);
  });

  it('the receipt form opens with what is still due and the PO rate only as a hint beside an empty rate', async () => {
    const s = await storekeeper(); const x = await setup(s);
    const p = await ok<{ id: string }>(po(s, x.sundaram, [{ materialId: x.core, quantity: 982, rate: 65 }]));
    await prisma.purchaseOrder.update({ where: { id: p.id }, data: { status: 'APPROVED' } });
    const opened = await pendingActions.create(s, { tool: 'record_goods_receipt', origin: 'AGENT', input: { purchaseOrderId: p.id } });
    if (!opened.ok) throw new Error('did not open');
    const card = await pendingActions.formCard(s, opened.data);
    expect(card.values).toMatchObject({ supplierId: x.sundaram, purchaseOrderId: p.id, receiptDate: today() });
    const lines = card.values.lines as { materialId: string; receivedQty: number; poRate: number; rate?: number }[];
    expect(lines).toMatchObject([{ materialId: x.core, receivedQty: 982, poRate: 65 }]);
    expect(lines[0]?.rate).toBeUndefined();
  });

  it('the approval form says what the owner approves, with the supplier, the lines, the total and the job', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    await ok(po(s, x.sundaram, [{ materialId: x.core, quantity: 982, rate: 65 }]));
    const opened = await pendingActions.create(o, { tool: 'approve_purchase_order', origin: 'LAUNCHER' });
    if (!opened.ok) throw new Error('did not open');
    const card = await pendingActions.formCard(o, opened.data);
    expect(card.info?.[0]).toContain('Sundaram Ferrites · ₹63,830');
    expect(card.info).toContain('Ferrite Core E-30: 982 pcs at ₹65/pcs = ₹63,830');
    expect(card.form.alt).toEqual({ tool: 'reject_purchase_order', label: 'Reject' });
  });
});

describe('email to the owner', () => {
  it('a PO waiting for him is emailed once (to the address in Settings), a failure never blocks a save, and with no email set up nothing is sent', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    expect(await sendOwnerEmails({ ...process.env, SMTP_URL: '' })).toBe(0); // not configured: the app is the only place he is told
    await prisma.setting.update({ where: { key: 'notify.owner_email' }, data: { value: 'owner@vijaya.example' } });
    const env = { ...process.env, SMTP_URL: 'json:', APP_URL: 'https://stores.example' };
    sentMail.length = 0;
    await ok(po(s, x.sundaram, [{ materialId: x.core, quantity: 982, rate: 65 }]));
    expect(await sendOwnerEmails(env)).toBe(1);
    expect(sentMail).toMatchObject([{ to: 'owner@vijaya.example', subject: 'Purchase order waiting', text: expect.stringContaining('₹63,830') }]);
    expect(sentMail[0]?.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // names and rupees, never ids
    expect(await sendOwnerEmails(env)).toBe(0); // once
    expect((await prisma.notification.findFirstOrThrow({ where: { userId: o.userId } })).emailSentAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId: s.userId, emailSentAt: { not: null } } })).toBe(0); // only the owner is emailed
  });
});
