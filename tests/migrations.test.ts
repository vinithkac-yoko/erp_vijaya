import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { assertGuards, checkGuards, EXPECTED_GUARD_CHECKS, EXPECTED_GUARD_TRIGGERS, EXPECTED_GUARD_VIEWS } from '@/server/guards';

/**
 * T17: `prisma migrate deploy` on an EMPTY database must produce every guard. This builds a brand-new database, deploys
 * the migrations exactly as Railway does, and asks the database (not our code) what exists.
 */
const base = new URL(process.env.DATABASE_URL as string);
const NAME = `vijaya_migrate_check_${process.pid}_test`;
const urlFor = (db: string) => { const u = new URL(base); u.pathname = `/${db}`; return u.toString(); };

let admin: PrismaClient;
let fresh: PrismaClient;

beforeAll(async () => {
  admin = new PrismaClient({ datasourceUrl: urlFor('postgres') });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${NAME}"`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${NAME}"`);
  execSync('pnpm exec prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: urlFor(NAME) } });
  fresh = new PrismaClient({ datasourceUrl: urlFor(NAME) });
}, 120_000);

afterAll(async () => {
  await fresh?.$disconnect();
  await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${NAME}"`);
  await admin?.$disconnect();
});

const names = async (q: Promise<{ n: string }[]>) => new Set((await q).map((r) => r.n));

describe('a fresh `prisma migrate deploy`', () => {
  it('creates every guard trigger, CHECK and view the boot check looks for', async () => {
    const triggers = await names(fresh.$queryRaw`SELECT tgname AS n FROM pg_trigger WHERE NOT tgisinternal`);
    for (const t of EXPECTED_GUARD_TRIGGERS) expect(triggers.has(t), `trigger ${t}`).toBe(true);
    const checks = await names(fresh.$queryRaw`SELECT conname AS n FROM pg_constraint WHERE contype = 'c'`);
    for (const c of EXPECTED_GUARD_CHECKS) expect(checks.has(c), `check ${c}`).toBe(true);
    const views = await names(fresh.$queryRaw`SELECT viewname AS n FROM pg_views WHERE schemaname = 'public'`);
    for (const v of EXPECTED_GUARD_VIEWS) expect(views.has(v), `view ${v}`).toBe(true);
  });

  it('passes the boot check', async () => {
    expect(await checkGuards(fresh)).toMatchObject({ missing: [] });
    await expect(assertGuards(fresh)).resolves.toBeUndefined();
  });

  it('the boot check refuses to start when a trigger is missing…', async () => {
    await fresh.$executeRawUnsafe('DROP TRIGGER trg_block_movement_update ON stock_movements');
    const status = await checkGuards(fresh);
    expect(status.missing).toEqual(['trg_block_movement_update']);
    await expect(assertGuards(fresh)).rejects.toThrow(/Refusing to start.*trg_block_movement_update/);
    await fresh.$executeRawUnsafe(`CREATE TRIGGER trg_block_movement_update BEFORE UPDATE ON stock_movements FOR EACH ROW EXECUTE FUNCTION block_ledger_mutation()`);
    expect((await checkGuards(fresh)).missing).toEqual([]);
  });

  it('…or when someone switches one off in the console', async () => {
    await fresh.$executeRawUnsafe('ALTER TABLE stock_movements DISABLE TRIGGER trg_stock_movement_apply');
    expect((await checkGuards(fresh)).missing).toEqual(['trg_stock_movement_apply']);
    await expect(assertGuards(fresh)).rejects.toThrow(/trg_stock_movement_apply/);
    await fresh.$executeRawUnsafe('ALTER TABLE stock_movements ENABLE TRIGGER trg_stock_movement_apply');
    expect((await checkGuards(fresh)).missing).toEqual([]);
  });

  it('…or when a CHECK or a view is gone', async () => {
    await fresh.$executeRawUnsafe('ALTER TABLE stock_movements DROP CONSTRAINT chk_issue_has_job');
    expect((await checkGuards(fresh)).missing).toEqual(['chk_issue_has_job']);
    await fresh.$executeRawUnsafe(`ALTER TABLE stock_movements ADD CONSTRAINT chk_issue_has_job CHECK (type NOT IN ('ISSUE','RETURN') OR "jobId" IS NOT NULL)`);
    await fresh.$executeRawUnsafe('DROP VIEW v_reorder_alerts');
    expect((await checkGuards(fresh)).missing).toEqual(['v_reorder_alerts']);
  });

  it('every trigger that exists in the database is on the boot check list (no guard that nobody checks)', async () => {
    const rows = await fresh.$queryRaw<{ n: string }[]>`SELECT tgname AS n FROM pg_trigger WHERE NOT tgisinternal`;
    expect(rows.map((r) => r.n).filter((n) => !(EXPECTED_GUARD_TRIGGERS as readonly string[]).includes(n)).sort()).toEqual([]);
  });

  it('has no Lot table and the movement table has no lotId (dormant scaffolding was dropped)', async () => {
    const t = await fresh.$queryRaw<{ n: string }[]>`SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = 'lots'`;
    expect(t).toEqual([]);
    const c = await fresh.$queryRaw<{ n: string }[]>`SELECT column_name AS n FROM information_schema.columns WHERE table_name = 'stock_movements' AND column_name = 'lotId'`;
    expect(c).toEqual([]);
  });
});
