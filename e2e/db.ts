import { PrismaClient } from '@prisma/client';
import { SETTINGS } from '../src/lib/settings';
import { materialNameKey, partyNameKey } from '../src/lib/names';
import { OWNER, STOREKEEPER } from './users';

export const prisma = new PrismaClient();

/** Between tests: empty everything the chat and the master data wrote, keep the two logins (any other login a test made goes), put the settings back. */
export async function resetData() {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL vijaya.allow_reset = 'on'`),
    prisma.$executeRawUnsafe(`TRUNCATE materials, parties, number_series, audit_events, stock_movements, pending_actions, conversations, settings, stock_counts, notifications CASCADE`),
  ]);
  await prisma.user.deleteMany({ where: { email: { notIn: [OWNER.email, STOREKEEPER.email] } } });
  for (const d of SETTINGS) await prisma.setting.create({ data: { key: d.key, value: d.initial, valueType: d.type } });
}

let n = 0;
/** Materials put straight into the table, as the owner would have added them before go-live. */
export async function addMaterials(list: { name: string; uom?: 'KG' | 'NOS' | 'MTR' | 'LTR'; isScrap?: boolean; min?: number }[]) {
  for (const m of list) {
    await prisma.material.create({ data: { code: `MAT-E${String(++n).padStart(4, '0')}`, name: m.name, nameKey: materialNameKey(m.name), uom: m.uom ?? 'NOS', stockType: m.min ? 'STANDING' : 'PER_JOB', minimumLevel: m.min, isScrap: m.isScrap ?? false } });
  }
}

/** Businesses put straight into the table, as the owner would have added them. */
export async function addParties(list: { name: string; kind?: 'customer' | 'supplier'; city?: string }[]) {
  const ids: Record<string, string> = {};
  for (const p of list) {
    const row = await prisma.party.create({ data: { code: `PTY-E${String(++n).padStart(4, '0')}`, name: p.name, nameKey: partyNameKey(p.name), isCustomer: (p.kind ?? 'customer') === 'customer', isSupplier: p.kind === 'supplier', city: p.city ?? 'Chennai' } });
    ids[p.name] = row.id;
  }
  return ids;
}

/** Stock that is already on the shelf: a receipt, the way the ledger takes it. */
export async function addStock(materialName: string, quantity: number, rate: number) {
  const m = await prisma.material.findFirstOrThrow({ where: { name: materialName } });
  const supplier = (await prisma.party.findFirst({ where: { isSupplier: true } })) ?? (await prisma.party.create({ data: { code: `PTY-E${String(++n).padStart(4, '0')}`, name: 'Test Supplier', nameKey: partyNameKey('Test Supplier'), isSupplier: true } }));
  const grn = await prisma.goodsReceipt.create({ data: { number: `GRN-E-${++n}`, supplierId: supplier.id, receiptDate: new Date() } });
  const line = await prisma.goodsReceiptLine.create({ data: { goodsReceiptId: grn.id, materialId: m.id, receivedQty: quantity, acceptedQty: quantity, rejectedQty: 0, rate, amount: quantity * rate } });
  await prisma.stockMovement.create({ data: { materialId: m.id, type: 'RECEIPT', direction: 'IN', quantity, rate, grnLineId: line.id, movementDate: new Date() } });
}

/** A job with its bill of materials, put straight into the table (quantities per piece). */
export async function addJob(customer: string, quantity: number, bom: { material: string; perPiece: number }[]) {
  const c = await prisma.party.findFirstOrThrow({ where: { name: customer } });
  const count = await prisma.job.count();
  const job = await prisma.job.create({ data: { number: `JOB-2627-${String(count + 1).padStart(4, '0')}`, customerId: c.id, productDescription: 'SMPS transformer 12V 2A', quantity, jobDate: new Date() } });
  for (const b of bom) {
    const m = await prisma.material.findFirstOrThrow({ where: { name: b.material } });
    await prisma.jobBomLine.create({ data: { jobId: job.id, materialId: m.id, qtyPerPiece: b.perPiece, requiredQty: Math.round(b.perPiece * quantity * 10_000) / 10_000 } });
  }
  return job;
}

/** A monthly count that was approved some time ago, with its lines (system, counted, reason), put straight into the table. */
export async function addApprovedCount(date: string, lines: { material: string; system: number; counted: number; reason?: string }[]) {
  const count = await prisma.stockCount.create({ data: { number: `CNT-E-${++n}`, countDate: new Date(`${date}T00:00:00+05:30`) } });
  for (const l of lines) {
    const m = await prisma.material.findFirstOrThrow({ where: { name: l.material } });
    await prisma.stockCountLine.create({ data: { stockCountId: count.id, materialId: m.id, systemQty: l.system, countedQty: l.counted, differenceQty: l.counted - l.system, reasonCode: l.reason } });
  }
  await prisma.stockCount.update({ where: { id: count.id }, data: { status: 'PENDING_APPROVAL' } });
  await prisma.stockCount.update({ where: { id: count.id }, data: { status: 'APPROVED' } });
  return count;
}

/** A purchase order for a supplier, put straight into the table, with its lines (rate per unit, GST per cent). */
export async function addPo(supplier: string, lines: { material: string; quantity: number; rate: number; gstRate?: number; hsn?: string }[], opts: { status?: 'APPROVED' | 'PENDING_APPROVAL'; number?: string } = {}) {
  const sup = await prisma.party.findFirstOrThrow({ where: { name: supplier } });
  let sub = 0, gst = 0;
  const rows = [];
  for (const l of lines) {
    const m = await prisma.material.findFirstOrThrow({ where: { name: l.material } });
    const amount = Math.round(l.quantity * l.rate * 100) / 100;
    sub += amount; gst += Math.round(amount * (l.gstRate ?? 0)) / 100;
    rows.push({ materialId: m.id, quantity: l.quantity, rate: l.rate, amount, hsnCode: l.hsn, gstRate: l.gstRate });
  }
  const count = await prisma.purchaseOrder.count();
  return prisma.purchaseOrder.create({ data: { number: opts.number ?? `PO-2627-${String(count + 1).padStart(4, '0')}`, supplierId: sup.id, poDate: new Date(), status: opts.status ?? 'APPROVED', subTotal: sub, gstAmount: gst, totalValue: sub + gst, approvedAt: (opts.status ?? 'APPROVED') === 'APPROVED' ? new Date() : null, lines: { create: rows } } });
}

/** A goods receipt (with the stock movement it makes) for a supplier. */
export async function addGrn(supplier: string, lines: { material: string; received: number; rejected?: number; rate: number }[], opts: { invoiceNo?: string } = {}) {
  const sup = await prisma.party.findFirstOrThrow({ where: { name: supplier } });
  const count = await prisma.goodsReceipt.count({ where: { number: { startsWith: 'GRN-2627-' } } });
  const grn = await prisma.goodsReceipt.create({ data: { number: `GRN-2627-${String(count + 1).padStart(4, '0')}`, supplierId: sup.id, receiptDate: new Date(), supplierInvoiceNo: opts.invoiceNo } });
  for (const l of lines) {
    const m = await prisma.material.findFirstOrThrow({ where: { name: l.material } });
    const rejected = l.rejected ?? 0;
    const line = await prisma.goodsReceiptLine.create({ data: { goodsReceiptId: grn.id, materialId: m.id, receivedQty: l.received, acceptedQty: l.received - rejected, rejectedQty: rejected, rejectionReason: rejected ? 'Damaged' : null, rate: l.rate, amount: (l.received - rejected) * l.rate } });
    await prisma.stockMovement.create({ data: { materialId: m.id, type: 'RECEIPT', direction: 'IN', quantity: l.received, rate: l.rate, grnLineId: line.id, movementDate: new Date() } });
    if (rejected) await prisma.stockMovement.create({ data: { materialId: m.id, type: 'REJECT_RETURN', direction: 'OUT', quantity: rejected, rate: l.rate, grnLineId: line.id, movementDate: new Date() } });
  }
  return grn;
}
