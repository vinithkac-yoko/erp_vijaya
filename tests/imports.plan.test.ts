import { describe, expect, it } from 'vitest';
import { gridFor, planImport, specProblems } from '@/server/tools/imports/plan';
import type { Answers, Grid, Snapshot, Spec, TableSpec } from '@/server/tools/imports/types';
import { materialNameKey, partNumberKey, partyNameKey, itemCodeKey } from '@/lib/names';

const emptySnap = (over: Partial<Snapshot> = {}): Snapshot => ({ materials: [], parties: [], parts: [], count: null, ...over });
const mat = (name: string, over: Partial<Snapshot['materials'][number]> = {}): Snapshot['materials'][number] => ({ id: `m-${name}`, name, nameKey: materialNameKey(name), itemCode: null, itemCodeKey: null, uom: 'NOS', category: null, rack: null, shelf: null, minimumLevel: null, stockType: 'PER_JOB', hsnCode: null, gstRate: null, isActive: true, ...over });
const party = (name: string, over: Partial<Snapshot['parties'][number]> = {}): Snapshot['parties'][number] => ({ id: `p-${name}`, name, nameKey: partyNameKey(name), gstin: null, city: null, state: null, addressLine: null, pincode: null, phone: null, email: null, isSupplier: true, isCustomer: false, isActive: true, ...over });
const grid = (rows: string[][], sheet = 'Sheet1'): Grid => ({ uploadId: 'u1', filename: 'list.xlsx', sheet, rows });
const table = (kind: TableSpec['kind'], columns: Record<string, string>, over: Partial<TableSpec> = {}): TableSpec => ({ uploadId: 'u1', kind, headerRow: 1, columns, ...over });
const spec = (...tables: TableSpec[]): Spec => ({ title: 'Test', tables });
const run = (t: TableSpec, g: Grid, snap = emptySnap(), answers: Answers = {}) => planImport(spec(t), [g], snap, answers);

describe('materials', () => {
  const head = ['Part', 'Item', 'Unit', 'Qty', 'Rack'];
  const cols = { itemCode: 'A', name: 'B', unit: 'C', quantity: 'D', rack: 'E' };
  const mt = (over: Partial<TableSpec> = {}) => table('materials', cols, { defaults: { stockType: 'PER_JOB' }, ...over });

  it('adds new materials with their unit, quantity and place, and puts the quantity on the opening count', () => {
    const p = run(mt(), grid([head, ['E1', 'EE42 Core', 'nos', '10', 'R1'], ['', 'Copper wire', 'KGS', '2.5', 'R2']]));
    expect(p.steps.map((s) => [s.tool, s.input.name ?? null])).toEqual([['create_material', 'EE42 Core'], ['create_material', 'Copper wire'], ['set_opening_quantities', null]]);
    expect(p.steps[0]!.input).toMatchObject({ uom: 'NOS', itemCode: 'E1', rack: 'R1', stockType: 'PER_JOB' });
    expect(p.steps[2]!.input).toMatchObject({ startIfMissing: true, items: [{ name: 'EE42 Core', qty: 10 }, { name: 'Copper wire', qty: 2.5 }] });
    expect(p.questions).toEqual([]);
  });

  it('never guesses a unit: it asks, and leaves those rows out until answered', () => {
    const g = grid([head, ['', 'Mystery part', '', '3', '']]);
    const open = run(mt(), g);
    expect(open.steps).toEqual([]);
    expect(open.questions).toHaveLength(1);
    expect(open.questions[0]).toMatchObject({ key: 'materials.unit', suggested: 'NOS', items: ['Mystery part'] });
    expect(open.questions[0]!.text).toMatch(/can never be changed/);
    const answered = run(mt(), g, emptySnap(), { 'materials.unit': { choice: 'KG' } });
    expect(answered.questions).toEqual([]);
    expect(answered.steps[0]!.input).toMatchObject({ uom: 'KG' });
  });

  it('leaves a row out, with the reason, when the owner says to leave out the unit-less ones', () => {
    const p = run(mt(), grid([head, ['', 'Mystery part', '', '3', '']]), emptySnap(), { 'materials.unit': { choice: 'hold' } });
    expect(p.steps).toEqual([]);
    expect(p.held[0]).toMatchObject({ item: 'Mystery part', reason: expect.stringContaining('leave it out') });
  });

  it('takes the unit from the quantity cell ("20 kgs") before anything else', () => {
    const p = run(mt(), grid([head, ['', 'Solder', '', '20 kgs', '']]));
    expect(p.steps[0]!.input.uom).toBe('KG');
    expect(p.steps[1]!.input).toMatchObject({ items: [{ name: 'Solder', qty: 20 }] });
  });

  it('holds back a fraction in pieces, a bad number, and a row with no name', () => {
    const p = run(mt(), grid([head, ['', 'Washer', 'nos', '3.5', ''], ['', 'Nut', 'nos', 'lots', ''], ['X9', '', 'nos', '1', '']]));
    expect(p.steps).toEqual([]);
    expect(p.held.map((h) => h.reason)).toEqual([expect.stringContaining('fraction'), expect.stringContaining('not a number'), expect.stringContaining('no name')]);
  });

  it('joins repeated names into one material and adds the quantities', () => {
    const p = run(mt(), grid([head, ['', 'Washer', 'nos', '3', 'R1'], ['', 'washer', 'nos', '4', 'R2']]));
    expect(p.steps.filter((s) => s.tool === 'create_material')).toHaveLength(1);
    expect(p.steps.at(-1)!.input).toMatchObject({ items: [{ name: 'Washer', qty: 7 }] });
    expect(p.steps[0]!.input.notes).toMatch(/R1.*R2/);
    expect(p.counts.merged).toBe(1);
  });

  it('gives a part number written against different names to none of them', () => {
    const p = run(mt(), grid([head, ['T1', 'Tape A', 'nos', '', ''], ['T1', 'Tape B', 'nos', '', '']]));
    for (const s of p.steps) { expect(s.input.itemCode).toBeUndefined(); expect(s.input.notes).toMatch(/also on other names/); }
  });

  it('asks about stock type when the sheet and the defaults do not say, and keeps kept-in-stock items at the agreed minimum', () => {
    const g = grid([head, ['', 'Washer', 'nos', '3', '']]);
    const t = table('materials', cols);
    const open = run(t, g);
    expect(open.questions[0]).toMatchObject({ key: 'materials.stockType', suggested: 'PER_JOB' });
    const done = run(t, g, emptySnap(), { 'materials.stockType': { choice: 'STANDING' } });
    expect(done.steps[0]!.input).toMatchObject({ stockType: 'STANDING', minimumLevel: 5 });
  });

  it('uses categories for the stock type when told which categories are kept in stock', () => {
    const t = table('materials', { name: 'A', unit: 'B', category: 'C' }, { standingCategories: ['misc'] });
    const p = run(t, grid([['n', 'u', 'c'], ['Clip', 'nos', 'MISC'], ['Core', 'nos', 'CORE']]));
    expect(p.steps.map((s) => [s.input.name, s.input.stockType])).toEqual([['Clip', 'STANDING'], ['Core', 'PER_JOB']]);
  });

  it('never overwrites silently: a different rack is a question; a blank in the system is just filled', () => {
    const snap = emptySnap({ materials: [mat('Washer', { rack: 'R9' }), mat('Nut', { rack: null })] });
    const g = grid([head, ['', 'Washer', 'nos', '', 'R1'], ['', 'Nut', 'nos', '', 'R2']]);
    const open = run(mt(), g, snap);
    expect(open.questions.map((q) => q.key)).toEqual(['materials.rack']);
    expect(open.questions[0]).toMatchObject({ items: ['Washer'], suggested: 'system', examples: ['Washer: system R9, sheet R1'] });
    expect(open.steps).toHaveLength(1); // only the blank is filled
    expect(open.steps[0]).toMatchObject({ tool: 'update_material', input: { materialId: 'm-Nut', rack: 'R2' } });
    const keep = run(mt(), g, snap, { 'materials.rack': { choice: 'system' } });
    expect(keep.steps).toHaveLength(1);
    const use = run(mt(), g, snap, { 'materials.rack': { choice: 'sheet' } });
    expect(use.steps.map((s) => s.input.materialId).sort()).toEqual(['m-Nut', 'm-Washer']);
    expect(use.steps.find((s) => s.input.materialId === 'm-Washer')!.before).toEqual({ rack: 'R9' });
    const mixed = run(mt(), g, snap, { 'materials.rack': { choice: 'sheet', perItem: { Washer: 'system' } } });
    expect(mixed.steps).toHaveLength(1);
  });

  it('says a unit that differs from the system cannot change, and leaves it', () => {
    const p = run(mt(), grid([head, ['', 'Solder', 'kg', '', '']]), emptySnap({ materials: [mat('Solder', { uom: 'NOS' })] }));
    expect(p.steps).toEqual([]);
    expect(p.notes[0]).toMatch(/can never be changed/);
  });

  it('asks before adding a name that looks like one already there', () => {
    const snap = emptySnap({ materials: [mat('22 SWG Copper Wire')] });
    const g = grid([head, ['', 'Copper Wire 22 SWG', 'kg', '', '']]);
    const open = run(mt(), g, snap);
    expect(open.questions[0]).toMatchObject({ key: 'materials.similar', suggested: 'skip' });
    expect(run(mt(), g, snap, { 'materials.similar': { choice: 'add' } }).steps).toHaveLength(1);
    expect(run(mt(), g, snap, { 'materials.similar': { choice: 'skip' } }).steps).toHaveLength(0);
  });

  it('puts quantities on an open count, asks when the count already has a different number, and refuses when the count is with the owner or approved', () => {
    const lines = new Map([[materialNameKey('Washer'), { countedQty: 5 }], [materialNameKey('Nut'), { countedQty: null }], [materialNameKey('Bolt'), { countedQty: 2 }]]);
    const snap = emptySnap({ materials: [mat('Washer'), mat('Nut'), mat('Bolt')], count: { id: 'c1', status: 'DRAFT', number: 'CNT-1', lines } });
    const g = grid([head, ['', 'Washer', 'nos', '9', ''], ['', 'Nut', 'nos', '4', ''], ['', 'Bolt', 'nos', '2', '']]);
    const open = run(mt(), g, snap);
    expect(open.questions).toHaveLength(1);
    expect(open.questions[0]).toMatchObject({ key: 'quantities.differs', items: ['Washer'] });
    expect(open.steps[0]).toMatchObject({ tool: 'set_opening_quantities', input: { startIfMissing: false, items: [{ name: 'Nut', qty: 4, previous: null }] } });
    const yes = run(mt(), g, snap, { 'quantities.differs': { choice: 'sheet' } });
    expect((yes.steps[0]!.input.items as unknown[]).length).toBe(2);
    for (const status of ['PENDING_APPROVAL', 'APPROVED']) {
      const blocked = run(mt(), g, { ...snap, count: { ...snap.count!, status } });
      expect(blocked.steps).toEqual([]);
      expect(blocked.notes.join(' ')).toMatch(/opening count/);
    }
  });
});

describe('suppliers and customers', () => {
  const head = ['Name', 'Role', 'GSTIN', 'City', 'Phone'];
  const cols = { name: 'A', role: 'B', gstin: 'C', city: 'D', phone: 'E' };
  const pt = (over: Partial<TableSpec> = {}) => table('parties', cols, over);

  it('adds new ones; asks for the role when the sheet has none', () => {
    const g = grid([head, ['Sundaram Ferrites Pvt Ltd', 'supplier', '33AAAAA0000A1Z5', 'Chennai', '98400 11111'], ['Acme', '', '', '', '']]);
    const open = run(pt(), g);
    expect(open.steps).toHaveLength(1);
    expect(open.steps[0]).toMatchObject({ tool: 'create_party', input: { name: 'Sundaram Ferrites Pvt Ltd', role: 'SUPPLIER', gstin: '33AAAAA0000A1Z5', city: 'Chennai' } });
    expect(open.questions[0]).toMatchObject({ key: 'parties.role', items: ['Acme'] });
    expect(run(pt(), g, emptySnap(), { 'parties.role': { choice: 'CUSTOMER' } }).steps).toHaveLength(2);
  });

  it('holds back a bad GSTIN or email, with the reason', () => {
    const p = run(pt(), grid([head, ['A', 'supplier', '123', '', ''], ['B', 'supplier', '', '', '']]), emptySnap());
    expect(p.held[0]!.reason).toMatch(/GSTIN/);
    expect(p.steps).toHaveLength(1);
  });

  it('knows a business that is already there (with or without Pvt Ltd), asks about a different city, fills a blank phone, and asks before adding a role', () => {
    const snap = emptySnap({ parties: [party('Sundaram Ferrites', { city: 'Madurai' })] });
    const g = grid([head, ['M/s Sundaram Ferrites Pvt. Ltd.', 'customer', '', 'Chennai', '98400 11111']]);
    const open = run(pt(), g, snap);
    expect(open.questions.map((q) => q.key).sort()).toEqual(['parties.addRole', 'parties.city']);
    expect(open.steps).toHaveLength(1);
    expect(open.steps[0]).toMatchObject({ tool: 'update_party', input: { partyId: 'p-Sundaram Ferrites', phone: '98400 11111' } });
    const all = run(pt(), g, snap, { 'parties.city': { choice: 'sheet' }, 'parties.addRole': { choice: 'add' } });
    expect(all.steps[0]!.input).toMatchObject({ city: 'Chennai', addRole: 'CUSTOMER', phone: '98400 11111' });
    expect(all.steps[0]!.before).toMatchObject({ city: 'Madurai' });
  });
});

describe('parts and bills of materials', () => {
  const customer = party('Bharat Electronics', { isSupplier: false, isCustomer: true });
  const parts = table('parts', { customer: 'A', partNumber: 'B', description: 'C' });
  const part = (n: string, over: Partial<Snapshot['parts'][number]> = {}): Snapshot['parts'][number] => ({ id: `t-${n}`, customerId: customer.id, customerName: customer.name, partNumber: n, partKey: partNumberKey(n), description: 'Old', hsnCode: null, isActive: true, bom: [], ...over });

  it('adds parts for a known customer; holds back an unknown one or a supplier', () => {
    const snap = emptySnap({ parties: [customer, party('Some Supplier')] });
    const p = run(parts, grid([['c', 'p', 'd'], ['Bharat Electronics', '9030', 'TXFR'], ['Nobody Ltd', '1', 'X'], ['Some Supplier', '2', 'Y']]), snap);
    expect(p.steps).toEqual([expect.objectContaining({ tool: 'create_part', input: { customerName: 'Bharat Electronics', partNumber: '9030', description: 'TXFR' } })]);
    expect(p.held.map((h) => h.reason)).toEqual([expect.stringContaining('not in the list'), expect.stringContaining('supplier')]);
  });

  it('can use a customer added by the same import', () => {
    const parties = table('parties', { name: 'A', role: 'B' });
    const out = planImport(spec(parts, parties), [grid([['c', 'p', 'd'], ['New Customer', '77', 'Thing']]), grid([['n', 'r'], ['New Customer', 'customer']])], emptySnap(), {});
    expect(out.steps.map((s) => s.tool)).toEqual(['create_party', 'create_part']);
  });

  it('asks before changing the description of a part that exists', () => {
    const snap = emptySnap({ parties: [customer], parts: [part('9030')] });
    const g = grid([['c', 'p', 'd'], ['Bharat Electronics', '9030', 'New words']]);
    expect(run(parts, g, snap).questions[0]).toMatchObject({ key: 'parts.description', examples: ['9030 · Bharat Electronics: system "Old", sheet "New words"'] });
    expect(run(parts, g, snap, { 'parts.description': { choice: 'sheet' } }).steps[0]).toMatchObject({ tool: 'update_part', input: { partId: 't-9030', description: 'New words' } });
  });

  const bomT = table('bom', { partNumber: 'A', material: 'B', qtyPerPiece: 'C' });
  it('makes a bill of materials for a part that has none, and joins a repeated material', () => {
    const snap = emptySnap({ parties: [customer], parts: [part('9030')], materials: [mat('Core'), mat('Wire')] });
    const p = run(bomT, grid([['p', 'm', 'q'], ['9030', 'Core', '1'], ['9030', 'Wire', '0.25'], ['9030', 'wire', '0.25']]), snap);
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toMatchObject({ tool: 'set_part_bom', input: { partNumber: '9030', lines: [{ materialName: 'Core', qtyPerPiece: 1 }, { materialName: 'Wire', qtyPerPiece: 0.5 }] } });
    expect(p.notes.join(' ')).toMatch(/more than once/);
  });

  it('leaves a whole part out when one of its lines cannot be matched', () => {
    const snap = emptySnap({ parties: [customer], parts: [part('9030')], materials: [mat('Core')] });
    const p = run(bomT, grid([['p', 'm', 'q'], ['9030', 'Core', '1'], ['9030', 'Unicorn hair', '1']]), snap);
    expect(p.steps).toEqual([]);
    expect(p.held.map((h) => h.reason).join(' ')).toMatch(/not in the materials list.*|Left out whole/s);
    expect(p.held.some((h) => /Left out whole/.test(h.reason))).toBe(true);
  });

  it('works with materials and parts added by the same import', () => {
    const mats = table('materials', { name: 'A', unit: 'B' }, { defaults: { stockType: 'PER_JOB' } });
    const snap = emptySnap({ parties: [customer] });
    const out = planImport(spec(bomT, parts, mats), [grid([['p', 'm', 'q'], ['9030', 'Brand new core', '1']]), grid([['c', 'p', 'd'], ['Bharat Electronics', '9030', 'TXFR']]), grid([['n', 'u'], ['Brand new core', 'nos']])], snap, {});
    expect(out.steps.map((s) => s.tool)).toEqual(['create_material', 'create_part', 'set_part_bom']);
  });

  it('asks before replacing a bill of materials that exists and differs; skips one that is the same', () => {
    const core = mat('Core');
    const snap = emptySnap({ parties: [customer], materials: [core, mat('Wire')], parts: [part('9030', { bom: [{ materialId: core.id, materialName: 'Core', qtyPerPiece: 2 }] })] });
    const same = run(bomT, grid([['p', 'm', 'q'], ['9030', 'Core', '2']]), snap);
    expect(same.steps).toEqual([]); expect(same.questions).toEqual([]);
    const g = grid([['p', 'm', 'q'], ['9030', 'Core', '1'], ['9030', 'Wire', '3']]);
    expect(run(bomT, g, snap).questions[0]).toMatchObject({ key: 'boms.replace', suggested: 'system' });
    const yes = run(bomT, g, snap, { 'boms.replace': { choice: 'sheet' } });
    expect(yes.steps[0]!.before).toEqual({ lines: [{ materialName: 'Core', qtyPerPiece: 2 }] });
  });

  it('asks which customer when two customers use the same part number', () => {
    const other = party('Other Co', { isSupplier: false, isCustomer: true });
    const snap = emptySnap({ parties: [customer, other], parts: [part('9030'), { ...part('9030'), id: 't2', customerId: other.id, customerName: other.name }], materials: [mat('Core')] });
    const p = run(bomT, grid([['p', 'm', 'q'], ['9030', 'Core', '1']]), snap);
    expect(p.held[0]!.reason).toMatch(/say which customer/);
  });
});

describe('the spec itself', () => {
  const g = grid([['a', 'b'], ['x', 'y']]);
  it('says in plain words what is wrong with a spec', () => {
    const bad = spec(table('materials', { name: 'A', colour: 'B', unit: 'F' }));
    const problems = specProblems(bad, [g]);
    expect(problems.join('\n')).toMatch(/"colour" is not a field/);
    expect(problems.join('\n')).toMatch(/column F \(unit\) is past the end/);
    expect(specProblems(spec(table('parts', { partNumber: 'A' })), [g]).join('\n')).toMatch(/say which column holds the the customer|customer/);
  });
  it('finds a sheet by name, and asks which when there are several', () => {
    const content = { sheets: [{ name: 'Stock', rows: [['a']] }, { name: 'Old', rows: [['b']] }], text: '' };
    expect(typeof gridFor(content, table('materials', {}), 'f.xlsx')).toBe('string');
    expect((gridFor(content, table('materials', {}, { sheet: 'stock' }), 'f.xlsx') as Grid).sheet).toBe('Stock');
    expect(gridFor(content, table('materials', {}, { sheet: 'nope' }), 'f.xlsx')).toMatch(/no sheet called/);
  });
  it('treats an answer that is not one of the options as no answer', () => {
    const p = run(table('materials', { name: 'A' }, { defaults: { stockType: 'PER_JOB', unit: 'nos' } }), grid([['n'], ['Thing']]), emptySnap(), { 'materials.stockType': { choice: 'banana' } });
    expect(p.steps).toHaveLength(1); // stock type came from the defaults, the junk answer is for a question that was never asked
    const q = run(table('materials', { name: 'A' }, { defaults: { stockType: 'PER_JOB' } }), grid([['n'], ['Thing']]), emptySnap(), { 'materials.unit': { choice: 'banana' } });
    expect(q.questions[0]!.key).toBe('materials.unit');
  });
});
void itemCodeKey;
