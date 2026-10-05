import { db } from './db';

/**
 * Database guard triggers that must exist before the app serves anything (VIJAYA prompt §3.2).
 * Milestone 1 has no ledger yet, so the list is empty. Milestone 2 fills it in together with the migration
 * that creates them (apply_stock_movement, append-only triggers, TRUNCATE guards, count guards).
 */
export const EXPECTED_GUARD_TRIGGERS: readonly string[] = [];

export interface GuardStatus { expected: number; missing: string[] }

export async function checkGuards(expected: readonly string[] = EXPECTED_GUARD_TRIGGERS): Promise<GuardStatus> {
  if (expected.length === 0) return { expected: 0, missing: [] };
  const rows = await db.$queryRaw<{ tgname: string }[]>`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`;
  const present = new Set(rows.map((r) => r.tgname));
  return { expected: expected.length, missing: expected.filter((n) => !present.has(n)) };
}

/** Called once at server start. An app running on an unguarded database must fail loudly, not quietly. */
export async function assertGuards(): Promise<void> {
  const { missing } = await checkGuards();
  if (missing.length > 0) {
    throw new Error(`Refusing to start: these database guards are missing: ${missing.join(', ')}. Run "prisma migrate deploy".`);
  }
}
