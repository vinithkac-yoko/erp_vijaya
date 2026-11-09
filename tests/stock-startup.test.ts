import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readOpeningStock } from '@/server/tools/stock-data';
import { loadOpeningStockOnce, MARKER_KEY } from '@/server/tools/stock-startup';
import { runTool, pendingActions } from '@/server/tools';
import { approveCount, makeMaterial, prisma, receive, resetDb } from './helpers/db';
import { ok, owner, save, seedSettings } from './helpers/tools';

const dir = mkdtempSync(join(tmpdir(), 'opening-stock-'));
let n = 0;
const material = (name: string, over: Record<string, unknown> = {}) => ({ name, itemCode: null, category: 'CORE', uom: 'NOS', stockType: 'PER_JOB', rack: 'R-01', shelf: 'A', notes: null, counted: 10, ...over });
const fileWith = (materials: unknown[], over: Record<string, unknown> = {}) => {
  const path = join(dir, `stock-${++n}.json`);
  writeFileSync(path, JSON.stringify({ source: 'a test sheet', madeOn: '2026-11-07', materials, ...over }));
  return path;
};
const standard = () => fileWith([
  material('EE42 CORE', { itemCode: 'FEE001', counted: 120, rack: 'R-07', shelf: 'C' }),
  material('label 20 x 10', { category: 'MISC', stockType: 'STANDING', minimumLevel: 5, counted: 9500 }),
  material('replace1', { category: 'SLEEVE', uom: 'MTR', counted: null }),
  material('T16 y/W', { counted: 0 }),
]);
const run = (path: string, env: Record<string, string> = {}) => loadOpeningStockOnce({ path, env });

beforeEach(async () => { await resetDb(); await seedSettings(); });
afterAll(() => prisma.$disconnect());

describe('loading the opening stock once, at start-up', () => {
  it('loads the materials and the count quantities through the gateway, leaves the count open, and writes the marker', async () => {
    const o = await owner();
    const r = await run(standard());
    expect(r).toMatchObject({ status: 'loaded', materials: 4, quantities: 3, refused: 0 });
    expect(await prisma.material.count()).toBe(4);
    expect(await prisma.material.findFirstOrThrow({ where: { name: 'label 20 x 10' } })).toMatchObject({ stockType: 'STANDING', category: 'MISC', rack: 'R-01' });
    // made the way a form would be: one audit row each, as the owner
    expect(await prisma.auditEvent.count({ where: { toolName: 'create_material' } })).toBe(4);
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'create_material' } })).toMatchObject({ actorId: o.userId, openedFrom: 'LAUNCHER' });
    const count = await prisma.stockCount.findFirstOrThrow({ where: { isOpening: true } });
    expect(count.status).toBe('DRAFT'); // never submitted: no rates
    expect(await prisma.stockMovement.count()).toBe(0);
    expect(await prisma.setting.findUnique({ where: { key: MARKER_KEY } })).not.toBeNull();
  });

  it('never runs a second time, even if a material was renamed or deactivated in between', async () => {
    await owner();
    await run(standard());
    const m = await prisma.material.findFirstOrThrow({ where: { name: 'EE42 CORE' } });
    await prisma.material.update({ where: { id: m.id }, data: { name: 'EE42 CORE (renamed)', nameKey: 'ee42corerenamed' } });
    const again = await run(standard());
    expect(again).toMatchObject({ status: 'skipped', reason: expect.stringContaining('already') });
    expect(await prisma.material.count()).toBe(4); // the old name was not made again
    expect(await prisma.stockCount.count()).toBe(1);
  });

  it('every skip says why, and saves nothing', async () => {
    await owner();
    const path = standard();
    expect(await run(path, { OPENING_STOCK_LOAD: 'off' })).toMatchObject({ status: 'skipped', reason: expect.stringContaining('off') });
    expect(await run(path, { DEMO_MODE: 'true' })).toMatchObject({ status: 'skipped', reason: expect.stringContaining('demo') });
    expect(await run(join(dir, 'nope.json'))).toMatchObject({ status: 'skipped', reason: expect.stringContaining('no stock file') });
    expect(await prisma.material.count()).toBe(0);
    expect(await prisma.setting.findUnique({ where: { key: MARKER_KEY } })).toBeNull(); // not loaded, so it will try again when it can
  });

  it('does nothing when there is no owner login yet', async () => {
    expect(await run(standard())).toMatchObject({ status: 'skipped', reason: expect.stringContaining('owner') });
    expect(await prisma.material.count()).toBe(0);
  });

  it('does nothing once stock has moved or the opening count is approved (the opening count has to come first)', async () => {
    await owner();
    const m = await makeMaterial({ name: 'Existing' });
    await receive(m.id, 5, 10);
    expect(await run(standard())).toMatchObject({ status: 'skipped', reason: expect.stringContaining('moved') });
    expect(await prisma.material.count()).toBe(1);

    await resetDb(); await seedSettings(); await owner();
    const first = await run(fileWith([material('only one', { counted: 1 })]));
    expect(first.status).toBe('loaded');
    await prisma.setting.delete({ where: { key: MARKER_KEY } });
    await prisma.stockCountLine.updateMany({ data: { unitRate: 10 } });
    await approveCount((await prisma.stockCount.findFirstOrThrow()).id);
    expect(await run(standard())).toMatchObject({ status: 'skipped' });
  });

  it('carries on after a part-way load without making any material twice, and never overwrites a typed quantity', async () => {
    await owner();
    const first = await run(standard());
    expect(first.status).toBe('loaded');
    await prisma.setting.delete({ where: { key: MARKER_KEY } }); // as if the first start had stopped before it finished
    const typed = await prisma.stockCountLine.findFirstOrThrow({ where: { material: { name: 'EE42 CORE' } } });
    const o = await owner();
    const form = await pendingActions.create(o, { tool: 'save_count_sheet', origin: 'LAUNCHER' });
    if (!form.ok) throw new Error('form');
    await ok(runTool(o, 'save_count_sheet', { stockCountId: typed.stockCountId, lines: [{ stockCountLineId: typed.id, countedQty: 118 }] }, { confirmation: form.data.id })); // the storekeeper corrects it
    const again = await run(standard());
    expect(again).toMatchObject({ status: 'loaded', materials: 0, quantities: 0 });
    expect(await prisma.material.count()).toBe(4);
    expect(Number((await prisma.stockCountLine.findUniqueOrThrow({ where: { id: typed.id } })).countedQty)).toBe(118);
  });

  it('a material already in the list joins the count instead of being made twice', async () => {
    await owner();
    await makeMaterial({ name: 'EE42 CORE', nameKey: 'ee42core' });
    const r = await run(standard());
    expect(r.status).toBe('loaded');
    expect(await prisma.material.count({ where: { nameKey: 'ee42core' } })).toBe(1);
  });
});

describe('the stock file', () => {
  it('a file that does not match the expected shape is refused, never half loaded', async () => {
    await owner();
    const bad = fileWith([material('x', { uom: 'BOXES' })]);
    await expect(run(bad)).rejects.toThrow();
    expect(await prisma.material.count()).toBe(0);
    expect(() => readOpeningStock(fileWith([]))).toThrow();
  });

  it('the real file in the code is valid, has no rates, and keeps the owner\'s rules', async () => {
    const { file, materials } = readOpeningStock(join(process.cwd(), 'prisma', 'data', 'opening-stock.json'));
    expect(materials.length).toBeGreaterThan(600);
    expect(new Set(materials.map((m) => m.name.toLowerCase().replace(/[^a-z0-9]/g, ''))).size).toBe(materials.length); // no two the same material
    expect(JSON.stringify(file)).not.toMatch(/rate|price|gstin|password|email/i);
    for (const m of materials) {
      expect(m.stockType === 'STANDING').toBe(m.category === 'MISC' || m.category === 'CONS');
      if (m.stockType === 'STANDING') expect(m.minimumLevel).toBe(5);
      expect(m.counted === null || m.counted >= 0).toBe(true);
    }
    expect(materials.filter((m) => /^replace\d+$/.test(m.name))).toHaveLength(7);
  });
});

describe('when the opening count is already with the owner (what happened on the live copy)', () => {
  const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  /** An opening count with one counted and rated material, sent to the owner. */
  async function countWithOwner() {
    const o = await owner();
    await ok(save(o, 'create_material', { name: 'Old item', uom: 'NOS', stockType: 'PER_JOB' }));
    await ok(save(o, 'start_stock_count', { countDate: today(), isOpening: true }));
    const sheet = await ok<{ count: { id: string }; rows: { id: string }[] }>(runTool(o, 'list_count_lines', {}));
    await ok(save(o, 'save_count_sheet', { stockCountId: sheet.count.id, lines: [{ stockCountLineId: sheet.rows[0]!.id, countedQty: 7, unitRate: 25 }] }));
    await ok(save(o, 'submit_stock_count', {}));
    return o;
  }

  it('starts nothing while the count is locked, and says what to do', async () => {
    await countWithOwner();
    const r = await run(standard());
    expect(r).toMatchObject({ status: 'skipped', reason: expect.stringContaining('Send it back') });
    expect(await prisma.material.count()).toBe(1); // no half load
    expect(await prisma.setting.findUnique({ where: { key: MARKER_KEY } })).toBeNull();
  });

  it('after the owner sends it back, every material is on the count and the next start loads the quantities onto it; the old line is kept', async () => {
    const o = await countWithOwner();
    // materials made while the count was locked (the half load the live copy got) have no line yet
    await ok(save(o, 'create_material', { name: 'EE42 CORE', uom: 'NOS', stockType: 'PER_JOB', rack: 'R-07' }));
    const before = await prisma.stockCountLine.count();
    expect(before).toBe(1);

    await ok(save(o, 'reject_stock_count', { rejectionNote: 'Recount with the stock sheet' }));
    expect(await prisma.stockCountLine.count()).toBe(2); // 'EE42 CORE' joined the count when it came back
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'reject_stock_count' } })).toMatchObject({ afterJson: expect.objectContaining({ materialsAddedToTheCount: 1 }) });

    const r = await run(standard());
    expect(r).toMatchObject({ status: 'loaded', materials: 3, quantities: 3 }); // 'EE42 CORE' was there; the other three were made; three quantities typed
    const lines = await prisma.stockCountLine.findMany({ include: { material: true } });
    const q = (name: string) => Number(lines.find((l) => l.material.name === name)!.countedQty);
    expect(q('Old item')).toBe(7); // never overwritten
    expect(q('EE42 CORE')).toBe(120);
    expect(q('label 20 x 10')).toBe(9500);
    expect(await prisma.stockCount.count()).toBe(1); // the same count, not a second one
    expect(await prisma.stockMovement.count()).toBe(0);
    expect(await prisma.setting.findUnique({ where: { key: MARKER_KEY } })).not.toBeNull();
  });
});
