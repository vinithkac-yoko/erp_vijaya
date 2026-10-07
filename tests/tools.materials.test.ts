import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runTool } from '@/server/tools';
import { balance, giveBack, issue, makeJob, prisma, receive, resetDb } from './helpers/db';
import { fails, material, ok, owner, save, storekeeper } from './helpers/tools';

beforeEach(() => resetDb());
afterAll(() => prisma.$disconnect());

const rows = async (s: Awaited<ReturnType<typeof storekeeper>>, tool: string, input: object = {}) => (await ok<{ rows: Record<string, unknown>[] }>(runTool(s, tool, input))).rows;

describe('create_material', () => {
  it('adds a material, with an audit row and an internal code nobody sees (ACCEPTANCE 1.1, 1.2)', async () => {
    const s = await storekeeper();
    const r = await ok<{ id: string; name: string; unit: string }>(save(s, 'create_material', material('Ferrite Core E-30', { stockType: 'STANDING', minimumLevel: 50 })));
    expect(r).toMatchObject({ name: 'Ferrite Core E-30', unit: 'NOS' });
    const row = await prisma.material.findUniqueOrThrow({ where: { id: r.id }, include: { balance: true } });
    expect(row).toMatchObject({ nameKey: 'ferritecoree30', stockType: 'STANDING', isActive: true });
    expect(Number(row.minimumLevel)).toBe(50);
    expect(row.code).toBe('MAT-0001');
    expect(Number(row.balance?.quantity)).toBe(0);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: r.id } });
    expect(ev).toMatchObject({ toolName: 'create_material', action: 'CREATE', actorId: s.userId, openedFrom: 'LAUNCHER' });
  });

  it('a material kept in stock needs a minimum; one bought per job has none (1.3, 1.4)', async () => {
    const s = await storekeeper();
    const f = await fails(save(s, 'create_material', material('Bobbin type-B', { stockType: 'STANDING' })));
    expect(f).toMatchObject({ code: 'MINIMUM_REQUIRED', field: 'minimumLevel' });
    expect(await prisma.material.count()).toBe(0);
    await ok(save(s, 'create_material', material('Bobbin type-B', { stockType: 'STANDING', minimumLevel: 100 })));
    const perJob = await ok<{ id: string }>(save(s, 'create_material', material('Varnish', { uom: 'LTR', minimumLevel: 25 })));
    expect((await prisma.material.findUniqueOrThrow({ where: { id: perJob.id } })).minimumLevel).toBeNull(); // a minimum on a per-job material is ignored
  });

  it('refuses the same name in any spelling (1.6: "add 22 swg copper wire")', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_material', material('22 SWG Copper Wire', { uom: 'KG' })));
    for (const again of ['22 swg copper wire', '22 SWG Copper-Wire', ' 22  SWG   Copper Wire ']) {
      const f = await fails(save(s, 'create_material', material(again, { uom: 'KG' })));
      expect(f).toMatchObject({ code: 'MATERIAL_EXISTS', field: 'name' });
      expect(f.message).toBe('"22 SWG Copper Wire" is already in the list.');
    }
    expect(await prisma.material.count()).toBe(1);
  });

  it('asks about a similar one, once, and the answer is the user\'s (1.7)', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_material', material('22 SWG Copper Wire', { uom: 'KG' })));
    const f = await fails(save(s, 'create_material', material('Copper Wire 22 SWG', { uom: 'KG' })));
    expect(f).toMatchObject({ code: 'SIMILAR_MATERIAL_EXISTS', field: 'name' });
    expect(f.details).toEqual({ matches: [{ name: '22 SWG Copper Wire', unit: 'kg' }] });
    expect(JSON.stringify(f)).not.toMatch(/MAT-|[0-9a-f]{8}-[0-9a-f]{4}/); // names only, no codes or ids
    expect(await prisma.material.count()).toBe(1);
    await ok(save(s, 'create_material', material('Copper Wire 22 SWG', { uom: 'KG', confirmNotDuplicate: true })));
    expect(await prisma.material.count()).toBe(2);
  });

  it('a different gauge is a different material and is not questioned', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_material', material('22 SWG Copper Wire', { uom: 'KG' })));
    await ok(save(s, 'create_material', material('24 SWG Copper Wire', { uom: 'KG' })));
    expect(await prisma.material.count()).toBe(2);
  });

  it('says what is wrong in plain words, next to the field', async () => {
    const s = await storekeeper();
    expect(await fails(save(s, 'create_material', material('Wire', { uom: 'GRAMS' })))).toMatchObject({ code: 'INVALID_INPUT', field: 'uom', message: 'Choose the unit from the list.' });
    expect(await fails(save(s, 'create_material', material('', {})))).toMatchObject({ field: 'name', message: 'Type the material name.' });
    expect(await fails(save(s, 'create_material', material('Wire', { stockType: 'SOMETIMES' })))).toMatchObject({ field: 'stockType' });
    expect(await fails(save(s, 'create_material', material('Wire', { gstRate: 150 })))).toMatchObject({ field: 'gstRate' });
    expect(await fails(save(s, 'create_material', { uom: 'KG', stockType: 'PER_JOB' }))).toMatchObject({ field: 'name' });
  });

  it('the form works the same for the owner', async () => {
    expect((await ok<{ name: string }>(save(await owner(), 'create_material', material('Thinner', { uom: 'LTR' })))).name).toBe('Thinner');
  });
});

describe('update_material', () => {
  async function standing() {
    const s = await storekeeper();
    const m = await ok<{ id: string }>(save(s, 'create_material', material('Ferrite Core E-30', { stockType: 'STANDING', minimumLevel: 50 })));
    return { s, id: m.id };
  }

  it('changes the minimum, HSN and GST on the right material (1.9)', async () => {
    const { s, id } = await standing();
    await ok(save(s, 'update_material', { materialId: id, minimumLevel: 80, hsnCode: '8504', gstRate: 18 }));
    const m = await prisma.material.findUniqueOrThrow({ where: { id } });
    expect([Number(m.minimumLevel), m.hsnCode, Number(m.gstRate)]).toEqual([80, '8504', 18]);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: id, action: 'UPDATE' } });
    expect((ev.beforeJson as { minimumLevel: number }).minimumLevel).toBe(50);
  });

  it('renames, but not onto a name that is taken', async () => {
    const { s, id } = await standing();
    await ok(save(s, 'create_material', material('Bobbin type-B')));
    expect(await fails(save(s, 'update_material', { materialId: id, name: 'bobbin type b' }))).toMatchObject({ code: 'MATERIAL_EXISTS' });
    await ok(save(s, 'update_material', { materialId: id, name: 'Ferrite Core E-35' }));
    expect((await prisma.material.findUniqueOrThrow({ where: { id } })).nameKey).toBe('ferritecoree35');
  });

  it("the unit and the way it is bought can't be changed (1.10)", async () => {
    const { s, id } = await standing();
    for (const bad of [{ uom: 'KG' }, { stockType: 'PER_JOB' }]) {
      const f = await fails(save(s, 'update_material', { materialId: id, ...bad }));
      expect(f.code).toBe('UNIT_LOCKED');
      expect(f.message).toContain('every past quantity');
    }
    const m = await prisma.material.findUniqueOrThrow({ where: { id } });
    expect([m.uom, m.stockType]).toEqual(['NOS', 'STANDING']);
  });

  it('a minimum only makes sense for material kept in stock; nothing to change is said plainly', async () => {
    const { s, id } = await standing();
    const perJob = await ok<{ id: string }>(save(s, 'create_material', material('Varnish', { uom: 'LTR' })));
    expect(await fails(save(s, 'update_material', { materialId: perJob.id, minimumLevel: 5 }))).toMatchObject({ code: 'MINIMUM_NOT_ALLOWED', field: 'minimumLevel' });
    expect(await fails(save(s, 'update_material', { materialId: id }))).toMatchObject({ code: 'NOTHING_TO_CHANGE' });
    expect(await fails(save(s, 'update_material', { materialId: 'nope' }))).toMatchObject({ code: 'NOT_FOUND', field: 'materialId' });
  });
});

describe('deactivate_material', () => {
  it('stops a material with no stock; it says "no longer in use", never "deleted" (1.12)', async () => {
    const s = await storekeeper();
    const { id } = await ok<{ id: string }>(save(s, 'create_material', material('Test Item')));
    const r = await ok<{ name: string }>(save(s, 'deactivate_material', { materialId: id, reason: 'not needed' }));
    expect(r.name).toBe('Test Item');
    expect((await prisma.material.findUniqueOrThrow({ where: { id } })).isActive).toBe(false);
    expect(await prisma.material.count()).toBe(1); // never deleted
    expect((await rows(s, 'search_materials')).map((x) => x.name)).not.toContain('Test Item'); // 1.13
    expect((await rows(s, 'search_materials', { includeInactive: true })).map((x) => x.name)).toContain('Test Item');
    expect(await fails(save(s, 'deactivate_material', { materialId: id }))).toMatchObject({ code: 'ALREADY_INACTIVE' });
  });

  it('refuses while any stock is left — even negative', async () => {
    const s = await storekeeper();
    const { id } = await ok<{ id: string }>(save(s, 'create_material', material('Wire', { uom: 'KG' })));
    await receive(id, 10, 100);
    const f = await fails(save(s, 'deactivate_material', { materialId: id }));
    expect(f).toMatchObject({ code: 'MATERIAL_HAS_STOCK', field: 'materialId' });
    expect(f.message).toBe('"Wire" still has 10 kg in stock. It can only be stopped when none is left.');
    const job = await makeJob();
    await issue(id, job.id, 10);
    await issue(id, job.id, 3);
    expect((await fails(save(s, 'deactivate_material', { materialId: id }))).message).toContain('-3 kg');
    await giveBack(id, job.id, 3);
    await ok(save(s, 'deactivate_material', { materialId: id })); // zero now
    expect((await balance(id)).qty).toBe(0);
  });
});

describe('search_materials and get_material_balance', () => {
  async function stocked() {
    const s = await storekeeper();
    for (const m of [material('22 SWG Copper Wire', { uom: 'KG' }), material('Ferrite Core E-30', { stockType: 'STANDING', minimumLevel: 50 }), material('Bobbin type-B', { stockType: 'STANDING', minimumLevel: 100 })]) await ok(save(s, 'create_material', m));
    return s;
  }

  it('finds what he means however he types it (21.21)', async () => {
    const s = await stocked();
    for (const q of ['ferite core e30', 'FERRITE CORE E 30', 'core e-30']) expect((await rows(s, 'search_materials', { query: q })).map((r) => r.name)).toEqual(['Ferrite Core E-30']);
    expect((await rows(s, 'search_materials', { query: 'wire' })).map((r) => r.name)).toEqual(['22 SWG Copper Wire']);
    expect(await rows(s, 'search_materials', { query: 'nonsense' })).toEqual([]);
    expect((await rows(s, 'search_materials', { stockType: 'STANDING' })).map((r) => r.name)).toEqual(['Bobbin type-B', 'Ferrite Core E-30']);
  });

  it('never returns an internal code or a password hash', async () => {
    const s = await stocked();
    expect(JSON.stringify(await rows(s, 'search_materials'))).not.toMatch(/MAT-\d|"code"/);
  });

  it('"how much copper wire do we have?" is 0 kg to begin with (1.15)', async () => {
    const s = await stocked();
    const r = await ok<{ rows: { material: string; quantity: number; unit: string }[] }>(runTool(s, 'get_material_balance', { materialNames: ['copper wire'] }));
    expect(r.rows).toMatchObject([{ material: '22 SWG Copper Wire', quantity: 0, unit: 'KG' }]);
  });

  it('shows quantity, rate, value and the warning flags', async () => {
    const s = await stocked();
    const wire = (await prisma.material.findFirstOrThrow({ where: { nameKey: '22swgcopperwire' } })).id;
    const core = (await prisma.material.findFirstOrThrow({ where: { nameKey: 'ferritecoree30' } })).id;
    await receive(wire, 142.6, 812);
    await receive(core, 18, 65);
    const job = await makeJob();
    await issue(wire, job.id, 150);
    const r = await ok<{ rows: Record<string, unknown>[]; notFound: string[] }>(runTool(s, 'get_material_balance', { materialNames: ['22 SWG Copper Wire', 'ferrite core e30', 'unicorn'] }));
    const by = Object.fromEntries(r.rows.map((x) => [x.material, x]));
    expect(by['22 SWG Copper Wire']).toMatchObject({ quantity: -7.4, isNegative: true, belowMinimum: false });
    expect(by['Ferrite Core E-30']).toMatchObject({ quantity: 18, averageRate: 65, value: 1170, belowMinimum: true, minimumLevel: 50 });
    expect(r.notFound).toEqual(['unicorn']);
  });

  it('with nothing named it lists every active material', async () => {
    const s = await stocked();
    const r = await ok<{ rows: unknown[] }>(runTool(s, 'get_material_balance', {}));
    expect(r.rows).toHaveLength(3);
  });

  it('draws a short table in the chat with names, units and ₹ in Indian style, and says when there are more', async () => {
    const s = await storekeeper();
    const wire = await ok<{ id: string }>(save(s, 'create_material', material('22 SWG Copper Wire', { uom: 'KG' })));
    await receive(wire.id, 142.6, 812);
    const tool = (await import('@/server/tools')).registry.get('get_material_balance');
    const data = await ok(runTool(s, 'get_material_balance', {}));
    const [card] = (tool as unknown as { view: (d: unknown) => { kind: string; rows: Record<string, string>[] }[] }).view(data);
    expect(card?.rows[0]).toMatchObject({ m: '22 SWG Copper Wire', q: '142.6 kg', v: '₹1,15,791' });
    for (let i = 0; i < 12; i++) await ok(save(s, 'create_material', material(`Extra ${i} part`)));
    const many = (tool as unknown as { view: (d: unknown) => { rows: unknown[]; note?: string }[] }).view(await ok(runTool(s, 'get_material_balance', {})));
    expect(many[0]?.rows).toHaveLength(10);
    expect(many[0]?.note).toBe('Showing 10 of 13.');
  });
});
