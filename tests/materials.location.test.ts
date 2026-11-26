import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runTool } from '@/server/tools';
import { prisma, resetDb } from './helpers/db';
import { fails, material, ok, save, seedSettings, storekeeper } from './helpers/tools';

beforeEach(async () => { await resetDb(); await seedSettings(); });
afterAll(() => prisma.$disconnect());

const rows = async (s: Awaited<ReturnType<typeof storekeeper>>, query: string) =>
  (await ok<{ rows: { name: string; rack: string | null; shelf: string | null; category: string | null }[] }>(runTool(s, 'search_materials', { query }))).rows;

describe('where a material is kept (milestone 13)', () => {
  it('create_material keeps the kind, rack, shelf and a note, and the audit row says them', async () => {
    const s = await storekeeper();
    const r = await ok<{ id: string; rack: string }>(save(s, 'create_material', material('EE42/21/15 N87 OL', { category: 'CORE', rack: 'R-07', shelf: 'C', notes: 'Also in R-08 A' })));
    expect(await prisma.material.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ category: 'CORE', rack: 'R-07', shelf: 'C', notes: 'Also in R-08 A' });
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: r.id } });
    expect(ev.afterJson).toMatchObject({ category: 'CORE', rack: 'R-07', shelf: 'C' });
  });

  it('all three are optional', async () => {
    const s = await storekeeper();
    const r = await ok<{ id: string }>(save(s, 'create_material', material('Varnish', { uom: 'LTR' })));
    expect(await prisma.material.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ category: null, rack: null, shelf: null });
  });

  it('search finds what is on a rack ("R-12", "rack 12", "r12") and what kind it is ("bobbin", "bobbins"), and still finds by name', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_material', material('E25 10PIN BOBBIN', { category: 'BOBBIN', rack: 'R-12', shelf: 'A' })));
    await ok(save(s, 'create_material', material('E30 BOBBIN', { category: 'BOBBIN', rack: 'R-13', shelf: 'B' })));
    await ok(save(s, 'create_material', material('EE42 CORE', { category: 'CORE', rack: 'R-12', shelf: 'B' })));
    await ok(save(s, 'create_material', material('Varnish', { uom: 'LTR' })));
    for (const q of ['R-12', 'rack 12', 'r12', 'R12']) expect((await rows(s, q)).map((m) => m.name).sort(), q).toEqual(['E25 10PIN BOBBIN', 'EE42 CORE']);
    for (const q of ['bobbin', 'Bobbins']) expect((await rows(s, q)).map((m) => m.name).sort(), q).toEqual(['E25 10PIN BOBBIN', 'E30 BOBBIN']);
    expect((await rows(s, 'varnish')).map((m) => m.name)).toEqual(['Varnish']);
    expect((await rows(s, 'e30'))[0]).toMatchObject({ name: 'E30 BOBBIN', rack: 'R-13', shelf: 'B', category: 'BOBBIN' });
  });

  it('a rack nobody uses is just a name search', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_material', material('E25 BOBBIN', { rack: 'R-12' })));
    expect(await rows(s, 'R-40')).toEqual([]);
  });

  it('update_material moves it to another rack; an unchanged value is "nothing to change"', async () => {
    const s = await storekeeper();
    const r = await ok<{ id: string }>(save(s, 'create_material', material('E25 BOBBIN', { rack: 'R-12', shelf: 'A' })));
    await ok(save(s, 'update_material', { materialId: r.id, rack: 'R-14', shelf: 'D' }));
    expect(await prisma.material.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ rack: 'R-14', shelf: 'D' });
    const again = await fails(save(s, 'update_material', { materialId: r.id, rack: 'R-14' }));
    expect(again.code).toBe('NOTHING_TO_CHANGE');
  });

  it('the count sheet shows where each material is', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_material', material('E25 BOBBIN', { rack: 'R-12', shelf: 'A' })));
    await ok(save(s, 'create_material', material('Varnish', { uom: 'LTR' })));
    await ok(save(s, 'start_stock_count', { countDate: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10), isOpening: true }));
    const sheet = await ok<{ rows: { material: string; where: string }[] }>(runTool(s, 'list_count_lines', {}));
    expect(sheet.rows.find((r) => r.material === 'E25 BOBBIN')?.where).toBe('R-12, shelf A');
    expect(sheet.rows.find((r) => r.material === 'Varnish')?.where).toBe('');
  });
});
