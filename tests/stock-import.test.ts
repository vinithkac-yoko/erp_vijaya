import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runTool } from '@/server/tools';
import { planStockImport, quantityOf, unitOf, type SheetRow } from '@/server/tools/stock-import';
import { applyStockPlan } from '@/server/tools/stock-load';
import { parseCsv } from '@/server/tools/stock-sheet-file';
import { approveCount, prisma, resetDb } from './helpers/db';
import { ok, owner, seedSettings } from './helpers/tools';

let n = 1;
const row = (over: Partial<SheetRow> = {}): SheetRow => ({ line: ++n, category: 'CORE', code: '', description: 'EE42 CORE', qty: '10', uom: 'NOS', rack: 'R-01', shelf: 'A', remark: '', ...over });
const plan = (rows: SheetRow[], existing?: Parameters<typeof planStockImport>[1]) => planStockImport(rows, existing);
const only = (rows: SheetRow[]) => { const p = plan(rows); expect(p.materials).toHaveLength(1); return p.materials[0]!; };

describe('units and quantities as the sheet writes them', () => {
  it('knows the way the sheet writes units', () => {
    expect(unitOf('KGS')).toEqual({ unit: 'KG' });
    expect(unitOf('Mtr')).toEqual({ unit: 'MTR' });
    expect(unitOf('N0S')).toEqual({ unit: 'NOS' });
    expect(unitOf('(ltr)')).toEqual({ unit: 'LTR' });
    expect(unitOf('ROLL')).toEqual({ unit: 'ROLL' });
    expect(unitOf('PAIR')).toMatchObject({ unit: 'SET', flag: expect.stringContaining('pairs') });
    expect(unitOf('GRM')).toMatchObject({ unit: 'KG', flag: expect.stringContaining('check') });
    expect(unitOf('whatever')).toBeNull();
  });
  it('reads quantities: plain, with a unit, NIL, blank, and nonsense', () => {
    expect(quantityOf('108')).toEqual({ qty: 108, unit: null });
    expect(quantityOf('1,950')).toEqual({ qty: 1950, unit: null });
    expect(quantityOf('20 KGS')).toEqual({ qty: 20, unit: { unit: 'KG' } });
    expect(quantityOf('7.kgs')).toEqual({ qty: 7, unit: { unit: 'KG' } });
    expect(quantityOf('5.MTR')).toEqual({ qty: 5, unit: { unit: 'MTR' } });
    expect(quantityOf('5 (ltr)')).toEqual({ qty: 5, unit: { unit: 'LTR' } });
    expect(quantityOf('1 (ROLL)')).toEqual({ qty: 1, unit: { unit: 'ROLL' } });
    expect(quantityOf('321(PAIR)').qty).toBe(321);
    expect(quantityOf('NIL')).toEqual({ qty: 0, unit: null });
    expect(quantityOf('')).toEqual({ qty: null, unit: null });
    expect(quantityOf('about ten').bad).toBe(true);
  });
});

describe("the owner's rules", () => {
  it('only MISC and CONS are kept in stock; everything else is bought for each job', () => {
    const p = plan([row({ category: 'MISC', description: 'label 20x10', code: 'WPL002' }), row({ category: 'cons', description: 'Thinner', uom: 'KGS' }), row({ category: 'CORE', description: 'EE42' }), row({ category: 'BOBBIN', description: 'E25 bobbin' }), row({ category: 'WIRE', description: '37 SS WIRE', uom: 'KGS' })]);
    const kind = (name: string) => p.materials.find((m) => m.name === name)!;
    expect(kind('label 20x10')).toMatchObject({ stockType: 'STANDING', minimumLevel: 0, category: 'MISC' });
    expect(kind('Thinner')).toMatchObject({ stockType: 'STANDING', category: 'CONS' });
    for (const other of ['EE42', 'E25 bobbin', '37 SS WIRE']) expect(kind(other)).toMatchObject({ stockType: 'PER_JOB' });
    expect(kind('EE42').minimumLevel).toBeUndefined();
  });

  it('a row with no description is named replace1, replace2 … and keeps its part number', () => {
    const p = plan([row({ description: '', code: 'SHR020', category: 'SLEEVE', uom: 'MTR', qty: '' }), row({ description: 'EE42' }), row({ description: '   ', code: 'SHR015', category: 'SLEEVE', uom: 'MTR', qty: '' })]);
    expect(p.materials.map((m) => m.name)).toEqual(['replace1', 'EE42', 'replace2']);
    expect(p.materials[0]).toMatchObject({ itemCode: 'SHR020', counted: null });
    expect(p.counts.replaceNamed).toBe(2);
  });

  it('the sheet that is not an item (no kind, no part number) is skipped, and said', () => {
    const p = plan([row({ category: '', code: '', description: 'Consumbles Items', qty: '0.0' }), row()]);
    expect(p.skipped).toHaveLength(1);
    expect(p.skipped[0]!.reason).toMatch(/not an item/);
    expect(p.materials).toHaveLength(1);
  });
});

describe('what cannot be trusted is said, not guessed', () => {
  it('the same description on several rows is one material and the quantities add up; where each was is kept in its note', () => {
    const m = only([row({ description: 'EE42/21/15 N87 OL', qty: '831', rack: 'R-07', shelf: 'A' }), row({ description: 'EE42/21/15  N87 OL', qty: '8736', rack: 'R-07', shelf: 'B' }), row({ description: 'ee42/21/15 n87 ol', qty: '1', rack: 'R-08', shelf: 'C' })]);
    expect(m.counted).toBe(9568);
    expect(m.rack).toBe('R-07');
    expect(m.notes).toContain('R-07 A (831)');
    expect(m.notes).toContain('R-08 C (1)');
  });

  it('a part number written against rows with different descriptions is given to none of them', () => {
    const p = plan([row({ description: 'sleeve 3.mm red', code: 'SHR030', category: 'SLEEVE', uom: 'MTR' }), row({ description: 'sleeve 1.mm red', code: 'SHR030', category: 'SLEEVE', uom: 'MTR' }), row({ description: 'sleeve 2 mm', code: 'SHR031', category: 'SLEEVE', uom: 'MTR' })]);
    expect(p.materials.map((m) => m.itemCode)).toEqual([null, null, 'SHR031']);
    expect(p.materials[0]!.notes).toContain('Code on the sheet: SHR030');
    expect(p.counts.codeShared).toBe(2);
  });

  it('a unit is never guessed from nothing: no unit anywhere means held back, because a unit can never change', () => {
    const p = plan([row({ category: 'CONS', description: 'Enamel remover', qty: '', uom: '' }), row({ category: 'CONS', description: 'Thinner', qty: '', uom: 'KGS' }), row({ category: 'CONS', description: 'Flux', qty: '5 (ltr)', uom: '5 LTR' })]);
    expect(p.heldBack.map((h) => h.row.description)).toEqual(['Enamel remover']);
    expect(p.materials.map((m) => [m.name, m.uom])).toEqual([['Thinner', 'KG'], ['Flux', 'LTR']]);
  });

  it('a whole kind counted in one unit lends it to a row that leaves it out (and says so)', () => {
    const rows = ['a', 'b', 'c', 'd'].map((d) => row({ category: 'SLEEVE', description: `sleeve ${d}`, uom: 'MTR' }));
    const m = plan([...rows, row({ category: 'SLEEVE', description: 'sleeve e', uom: '', qty: '' })]).materials.find((x) => x.name === 'sleeve e')!;
    expect(m.uom).toBe('MTR');
    expect(m.flags.join(' ')).toMatch(/every SLEEVE row is in MTR/);
  });

  it('the unit written with the quantity wins over the UOM column ("35 (ltr)" beside "3 LTR")', () => {
    const m = only([row({ category: 'CONS', description: 'Thinner agni', qty: '35 (ltr)', uom: '3 LTR' })]);
    expect(m).toMatchObject({ uom: 'LTR', counted: 35 });
  });

  it('NIL is counted as zero; a blank quantity is left uncounted', () => {
    const p = plan([row({ description: 'a', qty: 'NIL' }), row({ description: 'b', qty: '' })]);
    expect(p.materials.map((m) => m.counted)).toEqual([0, null]);
  });

  it('the same name in two units is held back, not merged', () => {
    const p = plan([row({ description: 'TY-30 E', qty: '11', uom: 'NOS' }), row({ description: 'TY-30 E', qty: '8.89', uom: 'KGS' })]);
    expect(p.materials).toHaveLength(1);
    expect(p.heldBack).toHaveLength(1);
    expect(p.heldBack[0]!.reason).toMatch(/different unit/);
  });

  it('a fraction in a unit counted whole is held back (the unit cannot be changed later, and one of the two is wrong)', () => {
    const p = plan([row({ description: 'TY-19 E', qty: '3.35', uom: 'NOS' }), row({ description: 'EE42', qty: '4' })]);
    expect(p.materials.map((m) => m.name)).toEqual(['EE42']);
    expect(p.heldBack[0]!.reason).toMatch(/fraction/);
  });

  it('rows with no description are not made again once a replace material exists (an earlier run made them)', () => {
    const p = plan([row({ description: '', code: 'SHR020', category: 'SLEEVE', uom: 'MTR' })], { nameKeys: new Set(['replace1']), itemCodeKeys: new Set(), replaceCount: 1 });
    expect(p.materials).toHaveLength(0);
  });

  it('materials already in the list are left alone', () => {
    const p = plan([row({ description: 'EE42 CORE' })], { nameKeys: new Set(['ee42core']), itemCodeKeys: new Set(), replaceCount: 0 });
    expect(p.materials).toHaveLength(0);
    expect(p.alreadyThere.map((m) => m.name)).toEqual(['EE42 CORE']);
  });
});

describe('the CSV reader', () => {
  it('handles quotes, commas and new lines inside quotes', () => {
    expect(parseCsv('a,"b,c","d ""e"" f"\n1,2,3\r\n"x\ny",,')).toEqual([['a', 'b,c', 'd "e" f'], ['1', '2', '3'], ['x\ny', '', '']]);
  });
});

beforeEach(async () => { await resetDb(); await seedSettings(); n = 1; });
afterAll(() => prisma.$disconnect());

describe('saving a plan through the gateway', () => {
  const sheet = () => [
    row({ category: 'CORE', code: 'FEE001', description: 'EE42 CORE', qty: '120', rack: 'R-07', shelf: 'A' }),
    row({ category: 'MISC', code: 'WPL002', description: 'label 20 x 10', qty: '9500', rack: 'R-01', shelf: 'A' }),
    row({ category: 'SLEEVE', code: 'SHR020', description: '', uom: 'MTR', qty: '' }),
    row({ category: 'WIRE', description: '37 SS WIRE', qty: '23.815', uom: 'KGS', rack: 'R-27', shelf: 'D' }),
    row({ category: 'CORE', description: 'T16 y/W', qty: 'NIL' }),
  ];

  it('adds every material and the opening count quantities, stamped as the person who ran it, and never submits the count', async () => {
    const o = await owner();
    const p = plan(sheet());
    const r = await applyStockPlan(p, o, '2026-11-06');
    expect(r).toMatchObject({ made: 5, refused: [], quantitiesSaved: 4, counted: 4, total: 5 });
    expect(r.needRate).toBe(3); // 120 + 9500 + 23.815 have stock but no rate yet

    const mats = await prisma.material.findMany({ orderBy: { name: 'asc' } });
    expect(mats).toHaveLength(5);
    const by = (name: string) => mats.find((m) => m.name === name)!;
    expect(by('label 20 x 10')).toMatchObject({ stockType: 'STANDING', category: 'MISC', rack: 'R-01', shelf: 'A', itemCode: 'WPL002' });
    expect(Number(by('label 20 x 10').minimumLevel)).toBe(0);
    expect(by('EE42 CORE')).toMatchObject({ stockType: 'PER_JOB', category: 'CORE', itemCode: 'FEE001', uom: 'NOS' });
    expect(by('37 SS WIRE')).toMatchObject({ uom: 'KG', rack: 'R-27' });
    expect(by('replace1')).toMatchObject({ itemCode: 'SHR020', uom: 'MTR', category: 'SLEEVE' });

    // each one has its own audit row, made as a form would be
    expect(await prisma.auditEvent.count({ where: { toolName: 'create_material' } })).toBe(5);
    expect(await prisma.auditEvent.count({ where: { toolName: 'start_stock_count' } })).toBe(1);
    expect(await prisma.auditEvent.findFirst({ where: { toolName: 'create_material' } })).toMatchObject({ actorId: o.userId, openedFrom: 'LAUNCHER' });

    // the count is open and nothing is in stock yet: no rates, nothing submitted, no movements
    const count = await prisma.stockCount.findFirstOrThrow({ where: { isOpening: true }, include: { lines: { include: { material: true } } } });
    expect(count.status).toBe('DRAFT');
    expect(count.lines).toHaveLength(5);
    const q = (name: string) => count.lines.find((l) => l.material.name === name)!.countedQty;
    expect(Number(q('EE42 CORE'))).toBe(120);
    expect(Number(q('37 SS WIRE'))).toBe(23.815);
    expect(Number(q('T16 y/W'))).toBe(0);
    expect(q('replace1')).toBeNull();
    expect(await prisma.stockMovement.count()).toBe(0);
  });

  it('running it again changes nothing, and never overwrites a quantity a person typed', async () => {
    const o = await owner();
    await applyStockPlan(plan(sheet()), o, '2026-11-06');
    // the storekeeper counts the sleeve and corrects the cores on the sheet
    const sheetNow = await ok<{ count: { id: string }; rows: { id: string; material: string }[] }>(runTool(o, 'list_count_lines', {}));
    const line = (name: string) => sheetNow.rows.find((r) => r.material === name)!.id;
    const { pendingActions } = await import('@/server/tools');
    const f = await pendingActions.create(o, { tool: 'save_count_sheet', origin: 'LAUNCHER' });
    if (!f.ok) throw new Error('form');
    await ok(runTool(o, 'save_count_sheet', { stockCountId: sheetNow.count.id, lines: [{ stockCountLineId: line('EE42 CORE'), countedQty: 118 }, { stockCountLineId: line('replace1'), countedQty: 40 }] }, { confirmation: f.data.id }));

    const existing = { nameKeys: new Set((await prisma.material.findMany()).map((m) => m.nameKey)), itemCodeKeys: new Set((await prisma.material.findMany()).flatMap((m) => (m.itemCodeKey ? [m.itemCodeKey] : []))), replaceCount: 1 };
    const again = plan(sheet(), existing);
    expect(again.materials).toHaveLength(0);
    expect(again.alreadyThere).toHaveLength(4); // their quantities are still offered to the count sheet; none is overwritten
    const r = await applyStockPlan(again, o, '2026-11-06');
    expect(r).toMatchObject({ made: 0, quantitiesSaved: 0 });
    expect(await prisma.material.count()).toBe(5);
    expect(await prisma.stockCount.count()).toBe(1);
    const lines = await prisma.stockCountLine.findMany({ include: { material: true } });
    expect(Number(lines.find((l) => l.material.name === 'EE42 CORE')!.countedQty)).toBe(118);
  });

  it('says so, and leaves the quantities, when the opening count is already approved', async () => {
    const o = await owner();
    await applyStockPlan(plan([row({ description: 'first', qty: '5' })]), o, '2026-11-06');
    await prisma.stockCountLine.updateMany({ data: { unitRate: 10 } }); // the database refuses a count that has stock with no rate
    await approveCount((await prisma.stockCount.findFirstOrThrow()).id);
    const r = await applyStockPlan(plan([row({ description: 'second', qty: '5' })]), o, '2026-11-06');
    expect(r).toMatchObject({ made: 1, countApproved: true, quantitiesSaved: 0 });
  });
});
