import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '@/server/demo/seed';
import { runTool } from '@/server/tools';
import { prisma, resetDb } from './helpers/db';
import { fails, ok, owner, save, seedSettings, storekeeper } from './helpers/tools';

beforeEach(async () => { await resetDb(); await seedSettings(); });
afterEach(() => { delete process.env.DEMO_MODE; });
afterAll(() => prisma.$disconnect());

async function demo() {
  const ow = await owner(); const sk = await storekeeper();
  await seedDemo({ owner: ow, storekeeper: sk });
  return { ow, sk };
}

describe('the demo month is built through the tools (VIJAYA prompt §7)', () => {
  it('has the story the owner is shown: twelve jobs for four customers, an open PO with three releases, a sample, a PO over the limit, a rejection, a rate jump, scrap, and a count with differences nobody could explain', async () => {
    const { ow } = await demo();
    expect(await prisma.material.count()).toBe(9);
    expect(await prisma.party.count({ where: { isSupplier: true } })).toBe(3);
    expect(await prisma.party.count({ where: { isCustomer: true } })).toBe(4);
    expect(await prisma.job.count()).toBe(12);
    expect(await prisma.job.count({ where: { type: 'SAMPLE' } })).toBe(1);
    expect(await prisma.job.count({ where: { customerPo: { number: 'SRSW-OP-44' } } })).toBe(3);
    expect(await prisma.stockCount.count({ where: { isOpening: true, status: 'APPROVED' } })).toBe(1);
    expect(await prisma.stockCount.count({ where: { isOpening: false, status: 'APPROVED' } })).toBe(1);
    const pending = await prisma.purchaseOrder.findMany({ where: { status: 'PENDING_APPROVAL' } });
    expect(pending.map((p) => Number(p.totalValue))).toEqual([63830]);
    expect(await prisma.goodsReceiptLine.count({ where: { rejectedQty: { gt: 0 } } })).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'RATE_CHANGE' } })).toBeGreaterThanOrEqual(1);    // 812 → 860
    expect(await prisma.stockMovement.count({ where: { reasonCode: 'TOP_UP' } })).toBe(1);
    expect(await prisma.stockMovement.count({ where: { type: 'SCRAP_IN' } })).toBe(2);
    expect(await prisma.scrapSale.count()).toBe(1);
    const leak = await ok<{ rows: { unexplainedCount: number }[]; totals: { unexplained: number } }>(runTool(ow, 'get_leak_report', {}));
    expect(leak.rows.length).toBeGreaterThanOrEqual(3);
    expect(leak.totals.unexplained).toBeGreaterThanOrEqual(2);
    // what the owner opens the chat to: something waiting, something below minimum
    expect((await ok<{ purchaseOrders: unknown[] }>(runTool(ow, 'list_pending_approvals', {}))).purchaseOrders).toHaveLength(1);
  }, 180_000);

  it('everything balances, nothing is negative, and every number is the ledger\'s own', async () => {
    await demo();
    expect(await prisma.$queryRaw`SELECT * FROM v_balance_integrity`).toEqual([]);
    expect(Number((await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM stock_balances WHERE quantity < 0`)[0]?.n)).toBe(0);
    expect(await prisma.auditEvent.count()).toBeGreaterThan(50);        // built by the tools, so every write has its audit row
    expect(await prisma.pendingAction.count({ where: { status: 'OPEN' } })).toBe(0);
  }, 180_000);
});

describe('"start the demo again" (VIJAYA prompt §7)', () => {
  it('refuses on a real copy, wipes nothing, and says why in plain words', async () => {
    const { ow } = await demo();
    delete process.env.DEMO_MODE;
    const before = await prisma.stockMovement.count();
    const f = await fails(save(ow, 'reset_demo_data', { confirm: true }));
    expect(f.code).toBe('NOT_DEMO');
    expect(f.message).toMatch(/only works on the demo copy/);
    expect(await prisma.stockMovement.count()).toBe(before);
  }, 180_000);

  it('is the owner\'s alone, and needs the box ticked', async () => {
    process.env.DEMO_MODE = 'true';
    const sk = await storekeeper(); const ow = await owner();
    expect((await fails(save(sk, 'reset_demo_data', { confirm: true }))).code).toBe('FORBIDDEN_ROLE');
    expect((await fails(save(ow, 'reset_demo_data', {}))).message).toBe('Tick the box to say you are sure.');
  });

  it('with DEMO_MODE on it wipes the business data and the trail, keeps the logins and settings, and builds the same month again', async () => {
    const { ow } = await demo();
    process.env.DEMO_MODE = 'true';
    const users = await prisma.user.count();
    const settings = await prisma.setting.count();
    await ok(save(ow, 'reset_demo_data', { confirm: true }));
    expect(await prisma.job.count()).toBe(12);
    expect(await prisma.material.count()).toBe(9);
    expect(await prisma.user.count()).toBe(users);
    expect(await prisma.setting.count()).toBe(settings);
    expect(await prisma.auditEvent.count({ where: { action: 'RESET' } })).toBe(1);
    expect(await prisma.$queryRaw`SELECT * FROM v_balance_integrity`).toEqual([]);
    // the document numbers start again, so the demo reads the same each time
    expect((await prisma.job.findFirstOrThrow({ orderBy: { number: 'asc' } })).number).toMatch(/-0001$/);
  }, 240_000);

  it('the ledger still cannot be emptied by anything else: only this tool\'s own transaction says it may', async () => {
    await demo();
    await expect(prisma.$executeRawUnsafe('TRUNCATE stock_movements CASCADE')).rejects.toThrow(/LEDGER_APPEND_ONLY/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE audit_events CASCADE')).rejects.toThrow(/LEDGER_APPEND_ONLY/);
  }, 180_000);
});
