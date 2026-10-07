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
export async function addMaterials(list: { name: string; uom?: 'KG' | 'NOS' | 'MTR' | 'LTR'; isScrap?: boolean }[]) {
  for (const m of list) {
    await prisma.material.create({ data: { code: `MAT-E${String(++n).padStart(4, '0')}`, name: m.name, nameKey: materialNameKey(m.name), uom: m.uom ?? 'NOS', stockType: 'PER_JOB', isScrap: m.isScrap ?? false } });
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
