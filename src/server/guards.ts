import type { PrismaClient } from '@prisma/client';
import { db } from './db';

/**
 * What the ledger migration (prisma/migrations/*_ledger_guards) creates. The app refuses to start without ALL of it,
 * and /api/health reports what is missing. tests/migrations.test.ts proves a fresh `prisma migrate deploy` creates
 * every name here, so this list and the SQL cannot drift apart.
 */
export const EXPECTED_GUARD_TRIGGERS = [
  'trg_stock_movement_apply',        // weighted average, running balance, the database decides the rate (sorts after the guards)
  'trg_guard_count_adjustment',      // OPENING / COUNT_ADJUSTMENT only from an approved count line, exact quantity
  'trg_guard_reversal',              // a reversal mirrors its original
  'trg_guard_count_submission',      // no blanks, one opening count, approved is final
  'trg_guard_count_line_lock',       // lines frozen once with the owner; system quantity frozen
  'trg_guard_count_delete',          // counts are kept
  'trg_guard_count_line_delete',
  'trg_block_movement_update',       // the ledger is append-only
  'trg_block_movement_delete',
  'trg_block_movement_truncate',
  'trg_block_audit_update',
  'trg_block_audit_truncate',
  'trg_block_artifact_version_update',
  'trg_block_artifact_version_truncate',
  'trg_create_balance_row',
] as const;

export const EXPECTED_GUARD_CHECKS = [
  'chk_movement_qty_positive', 'chk_movement_direction', 'chk_issue_has_job', 'chk_adjustment_has_count', 'chk_opening_has_count',
  'chk_receipt_has_grn', 'chk_sale_has_scrap_sale', 'chk_reversal_has_original', 'chk_grn_split', 'chk_count_difference',
  'chk_count_rate_positive', 'chk_party_gstin', 'chk_standing_has_minimum',
] as const;

export const EXPECTED_GUARD_VIEWS = ['v_balance_integrity', 'v_material_leak', 'v_job_material_cost', 'v_bom_vs_actual', 'v_reorder_alerts'] as const;

export interface GuardStatus { expected: number; missing: string[] }

/** Present AND switched on. A trigger someone disabled in the console counts as missing. */
export async function checkGuards(client: Pick<PrismaClient, '$queryRaw'> = db): Promise<GuardStatus> {
  const triggers = await client.$queryRaw<{ n: string }[]>`
    SELECT t.tgname AS n FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND t.tgenabled IN ('O', 'A') AND s.nspname = current_schema()`;
  const checks = await client.$queryRaw<{ n: string }[]>`
    SELECT con.conname AS n FROM pg_constraint con JOIN pg_namespace s ON s.oid = con.connamespace
    WHERE con.contype = 'c' AND con.convalidated AND s.nspname = current_schema()`;
  const views = await client.$queryRaw<{ n: string }[]>`SELECT viewname AS n FROM pg_views WHERE schemaname = current_schema()`;

  const has = (rows: { n: string }[]) => new Set(rows.map((r) => r.n));
  const t = has(triggers), c = has(checks), v = has(views);
  const missing = [
    ...EXPECTED_GUARD_TRIGGERS.filter((n) => !t.has(n)),
    ...EXPECTED_GUARD_CHECKS.filter((n) => !c.has(n)),
    ...EXPECTED_GUARD_VIEWS.filter((n) => !v.has(n)),
  ];
  return { expected: EXPECTED_GUARD_TRIGGERS.length + EXPECTED_GUARD_CHECKS.length + EXPECTED_GUARD_VIEWS.length, missing };
}

/** Called once at server start. An app running on an unguarded database must fail loudly, not quietly. */
export async function assertGuards(client: Pick<PrismaClient, '$queryRaw'> = db): Promise<void> {
  const { missing } = await checkGuards(client);
  if (missing.length > 0) {
    throw new Error(`Refusing to start: the database is missing these guards: ${missing.join(', ')}. Run "prisma migrate deploy".`);
  }
}
