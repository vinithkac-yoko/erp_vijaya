import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { planMaterialList, type ListRow } from '@/server/tools/material-list';
import { loadMaterialListsOnce, LIST_MARKER_PREFIX } from '@/server/tools/material-lists-startup';
import { readOpeningStock } from '@/server/tools/stock-data';
import { runTool } from '@/server/tools';
import { makeMaterial, prisma, resetDb } from './helpers/db';
import { ok, owner, save, seedSettings } from './helpers/tools';

let n = 0;
const r = (description: string, code = ''): ListRow => ({ line: ++n, description, code });
const opts = { category: 'TAPE', uom: 'NOS' as const, stockType: 'PER_JOB' as const };
const plan = (rows: ListRow[], existing?: Parameters<typeof planMaterialList>[2]) => planMaterialList(rows, opts, existing);

describe('planning a list of materials', () => {
  it('the part number in brackets at the end becomes the item code, and the name is the description without it', () => {
    const p = plan([r('T -090/B 25Mic Blue Polyester Tape 14.0mm (TB1014)', 'TB1014'), r('F240(WH) 12mmX55m (TC W012)', '(TC W012)'), r('T-180 1mil Kapton Adv.Tape 03mmX30Mtrs (TK1004)')]);
    expect(p.materials.map((m) => [m.name, m.itemCode])).toEqual([['T -090/B 25Mic Blue Polyester Tape 14.0mm', 'TB1014'], ['F240(WH) 12mmX55m', 'TC W012'], ['T-180 1mil Kapton Adv.Tape 03mmX30Mtrs', 'TK1004']]);
    expect(p.materials.every((m) => m.category === 'TAPE' && m.uom === 'NOS' && m.stockType === 'PER_JOB' && m.counted === null)).toBe(true);
  });

  it('new lines and odd spacing inside the cell are tidied, including a bracket split over two lines', () => {
    const p = plan([r('T -141/Y 25Mic Yellow Polyester Tape 19.0mm\n (TUY219\n)', 'TUY219'), r('T- 150  White Barrier Tape 2.0mm\n25mtr (TWB1002)', 'TWB1002')]);
    expect(p.materials.map((m) => [m.name, m.itemCode])).toEqual([['T -141/Y 25Mic Yellow Polyester Tape 19.0mm', 'TUY219'], ['T- 150 White Barrier Tape 2.0mm 25mtr', 'TWB1002']]);
  });

  it('a description with no part number is still added, with no item code', () => {
    const p = plan([r('I Inch Cotton Tape')]);
    expect(p.materials[0]).toMatchObject({ name: 'I Inch Cotton Tape', itemCode: null });
    expect(p.counts.withoutCode).toBe(1);
  });

  it('headings, totals and a part number alone on a line are skipped, and said', () => {
    const p = plan([r('Tape Discription', 'Part no.'), r('Particulars'), r('', '(TBW104)'), r('Grand Total'), r('F-302 White Barrier Adh Tape 2mmX50m (TBW104)')]);
    expect(p.materials.map((m) => m.name)).toEqual(['F-302 White Barrier Adh Tape 2mmX50m']);
    expect(p.skipped.map((s) => s.reason)).toHaveLength(4);
    expect(p.materials[0]!.itemCode).toBe('TBW104');
  });

  it('the same description twice (the list repeats the ones with no number at its end) is one material', () => {
    const p = plan([r('Yellow Polyester Tape 3mm'), r('F-302 Tape (TBW104)', 'TBW104'), r('yellow polyester  tape 3MM'), r('F-302 Tape (TBW104)', 'TBW104')]);
    expect(p.materials.map((m) => m.name)).toEqual(['Yellow Polyester Tape 3mm', 'F-302 Tape']);
    expect(p.materials[1]!.itemCode).toBe('TBW104'); // twice on the same description is not a clash
    expect(p.counts.merged).toBe(2);
  });

  it('a part number on two different descriptions is given to neither, and the note says so', () => {
    const p = plan([r('Yellow Tape 24.0mm (TY1046)', 'TY1046'), r('Yellow Tape 25.0mm (TY1046)', 'TY1046'), r('Yellow Tape 26.0mm (TY1050)', 'TY1050')]);
    expect(p.materials.map((m) => m.itemCode)).toEqual([null, null, 'TY1050']);
    expect(p.materials[0]!.notes).toContain('TY1046');
    expect(p.counts.codeShared).toBe(2);
  });

  it('a material already in the list is left alone, and a code already used is not given again', () => {
    const p = plan([r('Already there (TA100)', 'TA100'), r('New one (TA100)', 'TA100'), r('Other (TB200)', 'TB200')], { nameKeys: new Set(['alreadythere']), itemCodeKeys: new Set(['tb200']), replaceCount: 0 });
    expect(p.alreadyThere).toEqual(['Already there']);
    expect(p.materials.map((m) => [m.name, m.itemCode])).toEqual([['New one', 'TA100'], ['Other', null]]);
  });

  it('a bracket that is not a part number stays in the name ("F240(WH)", "(white)")', () => {
    const p = plan([r('Tape (white)'), r('Tape (see note)')]);
    expect(p.materials.map((m) => m.name)).toEqual(['Tape (white)', 'Tape (see note)']);
  });
});

let dir = '';
const listFile = (name: string, materials: unknown[]) => { writeFileSync(join(dir, name), JSON.stringify({ source: 'a test list', madeOn: '2026-11-21', materials })); };
const tape = (name: string, over: Record<string, unknown> = {}) => ({ name, itemCode: null, category: 'TAPE', uom: 'NOS', stockType: 'PER_JOB', rack: null, shelf: null, notes: null, counted: null, ...over });
const run = (env: Record<string, string> = {}) => loadMaterialListsOnce({ dir, env });

beforeEach(async () => { await resetDb(); await seedSettings(); dir = mkdtempSync(join(tmpdir(), 'material-lists-')); });
afterAll(() => prisma.$disconnect());

describe('adding the lists once, at start-up', () => {
  const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

  it('adds each material through the gateway as the owner (one audit row each) and writes a marker; a second start adds nothing', async () => {
    const o = await owner();
    listFile('a.json', [tape('Blue Tape 4mm', { itemCode: 'TB1006' }), tape('Cotton Tape')]);
    await run();
    expect(await prisma.material.count({ where: { category: 'TAPE' } })).toBe(2);
    expect(await prisma.material.findFirstOrThrow({ where: { name: 'Blue Tape 4mm' } })).toMatchObject({ itemCode: 'TB1006', uom: 'NOS', stockType: 'PER_JOB', category: 'TAPE' });
    expect(await prisma.auditEvent.count({ where: { toolName: 'create_material' } })).toBe(2);
    expect(await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'create_material' } })).toMatchObject({ actorId: o.userId, openedFrom: 'LAUNCHER' });
    expect(await prisma.setting.findUnique({ where: { key: `${LIST_MARKER_PREFIX}a.json` } })).not.toBeNull();
    const again = await run();
    expect(again.find((x) => x.file === 'a.json')).toMatchObject({ status: 'skipped', reason: 'added already' });
    expect(await prisma.material.count({ where: { category: 'TAPE' } })).toBe(2);
  });

  it('a material renamed afterwards is not added back by a later start', async () => {
    await owner();
    listFile('a.json', [tape('Cotton Tape')]);
    await run();
    const m = await prisma.material.findFirstOrThrow({ where: { name: 'Cotton Tape' } });
    await prisma.material.update({ where: { id: m.id }, data: { name: 'Cotton Tape 1 inch', nameKey: 'cottontape1inch' } });
    await run();
    expect(await prisma.material.count()).toBe(1);
  });

  it('a list that is already in part is carried on without making anything twice; an existing code is not reused', async () => {
    await owner();
    await makeMaterial({ name: 'Blue Tape 4mm', nameKey: 'bluetape4mm' });
    await makeMaterial({ name: 'Other thing', nameKey: 'otherthing', itemCode: 'TB1008', itemCodeKey: 'tb1008' });
    listFile('a.json', [tape('Blue Tape 4mm'), tape('Blue Tape 5mm', { itemCode: 'TB1008' }), tape('Blue Tape 6mm', { itemCode: 'TB1010' })]);
    await run();
    expect(await prisma.material.count({ where: { nameKey: 'bluetape4mm' } })).toBe(1);
    const five = await prisma.material.findFirstOrThrow({ where: { name: 'Blue Tape 5mm' } });
    expect(five.itemCode).toBeNull(); // TB1008 belongs to another material
    expect(five.notes).toContain('TB1008');
    expect(await prisma.material.findFirstOrThrow({ where: { name: 'Blue Tape 6mm' } })).toMatchObject({ itemCode: 'TB1010' });
  });

  it('does nothing when switched off, on a demo copy, or with no owner; and a bad file stops that file, not the start', async () => {
    listFile('a.json', [tape('Cotton Tape')]);
    expect(await run({ MATERIAL_LISTS_LOAD: 'off' })).toEqual([]);
    expect(await run({ DEMO_MODE: 'true' })).toEqual([]);
    expect(await run()).toEqual([{ file: 'a.json', status: 'skipped', made: 0, reason: 'no owner' }]);
    expect(await prisma.material.count()).toBe(0);
    await owner();
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ source: 'x', madeOn: 'y', materials: [{ name: 'bad', uom: 'BOXES' }] }));
    await expect(run()).rejects.toThrow();
    expect(await prisma.material.count()).toBe(0);
  });

  it('with the opening count open, the new materials join it uncounted; with it with the owner, they join when it is sent back', async () => {
    const o = await owner();
    await ok(save(o, 'create_material', { name: 'Old item', uom: 'NOS', stockType: 'PER_JOB' }));
    await ok(save(o, 'start_stock_count', { countDate: today(), isOpening: true }));
    listFile('a.json', [tape('Blue Tape 4mm')]);
    await run();
    expect(await prisma.stockCountLine.count()).toBe(2);
    expect((await prisma.stockCountLine.findFirstOrThrow({ where: { material: { name: 'Blue Tape 4mm' } } })).countedQty).toBeNull();

    // the same, but with the count already with the owner: locked, so no line yet; sending it back adds it
    await resetDb(); await seedSettings();
    const o2 = await owner();
    await ok(save(o2, 'create_material', { name: 'Old item', uom: 'NOS', stockType: 'PER_JOB' }));
    await ok(save(o2, 'start_stock_count', { countDate: today(), isOpening: true }));
    const sheet = await ok<{ count: { id: string }; rows: { id: string }[] }>(runTool(o2, 'list_count_lines', {}));
    await ok(save(o2, 'save_count_sheet', { stockCountId: sheet.count.id, lines: [{ stockCountLineId: sheet.rows[0]!.id, countedQty: 3, unitRate: 10 }] }));
    await ok(save(o2, 'submit_stock_count', {}));
    listFile('a.json', [tape('Blue Tape 5mm')]);
    await run();
    expect(await prisma.stockCountLine.count()).toBe(1);
    await ok(save(o2, 'reject_stock_count', { rejectionNote: 'recount' }));
    expect(await prisma.stockCountLine.count()).toBe(2);
  });
});

describe('the real list in the code', () => {
  it('is valid, has no quantities, no repeated part number and no repeated name', () => {
    const { materials } = readOpeningStock(join(process.cwd(), 'prisma', 'data', 'materials', 'tape-part-numbers.json'));
    expect(materials.length).toBeGreaterThan(100);
    expect(materials.every((m) => m.counted === null && m.category === 'TAPE' && m.stockType === 'PER_JOB' && m.uom === 'NOS')).toBe(true);
    const codes = materials.flatMap((m) => (m.itemCode ? [m.itemCode.toLowerCase().replace(/[^a-z0-9]/g, '')] : []));
    expect(new Set(codes).size).toBe(codes.length);
    const names = materials.map((m) => m.name.toLowerCase().replace(/[^a-z0-9]/g, ''));
    expect(new Set(names).size).toBe(names.length);
    expect(materials.some((m) => /\(\s*T[A-Z]{1,3}\d+\s*\)\s*$/.test(m.name))).toBe(false); // no part number left in a name
  });
});
