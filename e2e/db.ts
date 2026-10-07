import { PrismaClient } from '@prisma/client';
import { SETTINGS } from '../src/lib/settings';
import { materialNameKey } from '../src/lib/names';
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
