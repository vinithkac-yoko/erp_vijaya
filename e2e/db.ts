import { PrismaClient } from '@prisma/client';
import { SETTINGS } from '../src/lib/settings';
import { OWNER, STOREKEEPER } from './users';

export const prisma = new PrismaClient();

/** Between tests: empty everything the chat and the master data wrote, keep the two logins (any other login a test made goes), put the settings back. */
export async function resetData() {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL vijaya.allow_reset = 'on'`),
    prisma.$executeRawUnsafe(`TRUNCATE materials, parties, number_series, audit_events, stock_movements, pending_actions, conversations, settings CASCADE`),
  ]);
  await prisma.user.deleteMany({ where: { email: { notIn: [OWNER.email, STOREKEEPER.email] } } });
  for (const d of SETTINGS) await prisma.setting.create({ data: { key: d.key, value: d.initial, valueType: d.type } });
}
