import { PrismaClient, type Prisma } from '@prisma/client';
import { expect } from 'vitest';
import { mapError } from '@/server/errors';
import { materialNameKey, partyNameKey } from '@/lib/names';

export const prisma = new PrismaClient();

let counter = 0;
export const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Empties every table the way the demo reset will: TRUNCATE inside a transaction that sets vijaya.allow_reset. */
export async function resetDb(client: PrismaClient = prisma) {
  await client.$transaction([
    client.$executeRawUnsafe(`SET LOCAL vijaya.allow_reset = 'on'`),
    client.$executeRawUnsafe(
      `TRUNCATE users, parties, materials, number_series, settings, attachments, audit_events, stock_movements, artifact_versions CASCADE`,
    ),
  ]);
}

export const makeUser = (role: 'OWNER' | 'STOREKEEPER' = 'OWNER') =>
  prisma.user.create({ data: { name: `Test ${role} ${uid()}`, email: `u${uid()}@test.local`, role, passwordHash: 'x' } });

export function makeMaterial(over: Partial<Prisma.MaterialUncheckedCreateInput> = {}) {
  const name = over.name ?? `Material ${uid()}`;
  return prisma.material.create({
    data: { code: `MAT-${uid()}`, name, nameKey: materialNameKey(name), uom: 'KG', stockType: 'PER_JOB', ...over },
  });
}

export function makeParty(kind: 'supplier' | 'customer' = 'supplier', over: Partial<Prisma.PartyUncheckedCreateInput> = {}) {
  const name = over.name ?? `${kind} ${uid()}`;
  return prisma.party.create({
    data: { code: `PTY-${uid()}`, name, nameKey: partyNameKey(name), isSupplier: kind === 'supplier', isCustomer: kind === 'customer', ...over },
  });
}

export async function makeJob(over: Partial<Prisma.JobUncheckedCreateInput> = {}) {
  const customerId = over.customerId ?? (await makeParty('customer')).id;
  return prisma.job.create({
    data: { number: `JOB-T-${uid()}`, customerId, productDescription: 'Test transformer', quantity: 100, jobDate: new Date(), ...over },
  });
}

export const move = (data: Omit<Prisma.StockMovementUncheckedCreateInput, 'movementDate'> & { movementDate?: Date }) =>
  prisma.stockMovement.create({ data: { movementDate: new Date(), ...data } });

let supplierId: string | undefined;
/** A goods receipt line for `qty` accepted, then the RECEIPT movement against it. */
export async function receive(materialId: string, qty: number, rate: number) {
  supplierId = supplierId && (await prisma.party.findUnique({ where: { id: supplierId } })) ? supplierId : (await makeParty('supplier')).id;
  const grn = await prisma.goodsReceipt.create({ data: { number: `GRN-T-${uid()}`, supplierId, receiptDate: new Date() } });
  const line = await prisma.goodsReceiptLine.create({
    data: { goodsReceiptId: grn.id, materialId, receivedQty: qty, acceptedQty: qty, rejectedQty: 0, rate, amount: qty * rate },
  });
  return move({ materialId, type: 'RECEIPT', direction: 'IN', quantity: qty, rate, grnLineId: line.id });
}
export const forgetSupplier = () => { supplierId = undefined; };

export const issue = (materialId: string, jobId: string, qty: number, rate = 1) =>
  move({ materialId, type: 'ISSUE', direction: 'OUT', quantity: qty, rate, jobId });
export const giveBack = (materialId: string, jobId: string, qty: number, rate = 1) =>
  move({ materialId, type: 'RETURN', direction: 'IN', quantity: qty, rate, jobId });

export async function balance(materialId: string) {
  const b = await prisma.stockBalance.findUniqueOrThrow({ where: { materialId } });
  return { qty: Number(b.quantity), rate: Number(b.averageRate), value: Number(b.stockValue) };
}

// ── counts ──
export const makeCount = (over: Partial<Prisma.StockCountUncheckedCreateInput> = {}) =>
  prisma.stockCount.create({ data: { number: `CNT-T-${uid()}`, countDate: new Date(), ...over } });

export const addLine = (stockCountId: string, materialId: string, o: { system?: number; counted?: number; rate?: number; reason?: string } = {}) => {
  const system = o.system ?? 0;
  return prisma.stockCountLine.create({
    data: {
      stockCountId, materialId, systemQty: system,
      countedQty: o.counted, differenceQty: o.counted === undefined ? undefined : o.counted - system,
      unitRate: o.rate, reasonCode: o.reason,
    },
  });
};
export const setCountStatus = (id: string, status: Prisma.StockCountUpdateInput['status']) =>
  prisma.stockCount.update({ where: { id }, data: { status } });

/** draft → with the owner → approved, the way the approve tool will do it. */
export async function approveCount(id: string) {
  await setCountStatus(id, 'PENDING_APPROVAL');
  return setCountStatus(id, 'APPROVED');
}

/** Every integration test ends with this: the ledger and the balances must agree. */
export async function expectIntegrity() {
  const rows = await prisma.$queryRaw<unknown[]>`SELECT * FROM v_balance_integrity`;
  expect(rows).toEqual([]);
}

/** Runs something that must fail, and returns what the user would see. */
export async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return mapError(err);
  }
  throw new Error('expected the database to refuse this, but it was accepted');
}

/** No database words may ever reach a user. */
export const RAW_DB_WORDS = /violates|constraint|relation |ERROR:|P2\d{3}|SQLSTATE|stock_movements|trigger|pg_|\bnull\b|Prisma|invocation/i;
export function expectPlain(m: { code: string; message: string }) {
  expect(m.message).not.toMatch(RAW_DB_WORDS);
  expect(m.message.length).toBeGreaterThan(10);
}
