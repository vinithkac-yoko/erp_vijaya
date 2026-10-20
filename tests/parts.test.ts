import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pendingActions } from '@/server/tools';
import { prisma, resetDb } from './helpers/db';
import { fails, material, ok, owner, save, seedSettings, storekeeper } from './helpers/tools';
import { runTool } from '@/server/tools';

beforeEach(async () => { await resetDb(); await seedSettings(); });
afterAll(() => prisma.$disconnect());

type S = Awaited<ReturnType<typeof storekeeper>>;
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

const party = async (s: S, name: string) => (await ok<{ id: string }>(save(s, 'create_party', { name, role: 'CUSTOMER', city: 'Hyderabad' }))).id;
const mat = async (s: S, name: string, uom: string, over: Record<string, unknown> = {}) => (await ok<{ id: string }>(save(s, 'create_material', material(name, { uom, ...over })))).id;
const part = (s: S, customerId: string, partNumber: string, description: string) => ok<{ id: string }>(save(s, 'create_part', { customerId, partNumber, description }));
type Rows<T = Record<string, unknown>> = { rows: T[] };

describe('parts: everything runs by part number (client paperwork, 2026-10-20)', () => {
  it('a part belongs to a customer; the same number is refused twice for one customer but fine for another', async () => {
    const s = await storekeeper();
    const medha = await party(s, 'Medha Servo Drives'); const ashok = await party(s, 'Ashok Transformers');
    await part(s, medha, '90308200008', 'TXFR FOR M634VOC');
    // "90308200008 " and "9030-8200008" are the same number
    expect((await fails(save(s, 'create_part', { customerId: medha, partNumber: ' 9030-8200008 ', description: 'again' }))).code).toBe('PART_EXISTS');
    const other = await ok<{ id: string }>(save(s, 'create_part', { customerId: ashok, partNumber: '90308200008', description: 'Ashok version' }));
    expect(other.id).toBeTruthy();
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'create_part' }, orderBy: { createdAt: 'desc' } });
    expect(ev.afterJson).toMatchObject({ sameNumberFor: 'Medha Servo Drives' });
    expect(await prisma.part.count()).toBe(2);
  });

  it('a supplier is not a customer, and the customer can be named as the assistant sends it', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_party', { name: 'Sundaram Ferrites', role: 'SUPPLIER' }));
    await party(s, 'Medha Servo Drives');
    expect((await fails(save(s, 'create_part', { customerName: 'Sundaram Ferrites', partNumber: '1', description: 'x' }))).code).toBe('PARTY_WRONG_ROLE');
    await ok(save(s, 'create_part', { customerName: 'Medha Servo Drives', partNumber: '90301030002', description: 'MPS8T 24V SINGLE TXFR FOR ELECTRIC' }));
    expect(await prisma.part.count()).toBe(1);
  });

  it('list_parts finds a part by its number, a piece of it, a pasted "number-description", or words; two customers with one number are asked about', async () => {
    const s = await storekeeper();
    const medha = await party(s, 'Medha Servo Drives'); const ashok = await party(s, 'Ashok Transformers');
    await part(s, medha, '90308200008', 'TXFR FOR M634VOC'); await part(s, medha, '90306700245', 'L8 TXFR FOR M110LTPS'); await part(s, ashok, '90308200008', 'Ashok version');
    const names = async (q: string) => (await ok<Rows<{ partNumber: string; customer: string }>>(runTool(s, 'list_parts', { query: q }))).rows.map((r) => `${r.partNumber}/${r.customer}`).sort();
    expect(await names('90308200008')).toEqual(['90308200008/Ashok Transformers', '90308200008/Medha Servo Drives']);
    expect(await names('9030-6700')).toEqual(['90306700245/Medha Servo Drives']);
    expect(await names('M110LTPS')).toEqual(['90306700245/Medha Servo Drives']);
    // a part number alone is ambiguous across customers; a customer settles it
    const amb = await runTool(s, 'get_part', { partId: '90308200008' });
    expect(amb).toMatchObject({ ok: false, code: 'PART_AMBIGUOUS' });
    expect(JSON.stringify(amb)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    const one = await ok<{ part: { description: string } }>(runTool(s, 'get_part', { partId: '90308200008-TXFR FOR M634VOC', customerName: 'Medha Servo Drives' }));
    expect(one.part.description).toBe('TXFR FOR M634VOC');
  });

  it('update_part fixes a typing mistake, refuses a clash, and marks a part no longer made (which stops new jobs)', async () => {
    const s = await storekeeper(); const c = await party(s, 'Medha Servo Drives');
    const a = await part(s, c, '90308200008', 'TXFR'); await part(s, c, '90308200009', 'Other');
    expect((await fails(save(s, 'update_part', { partId: a.id, partNumber: '90308200009' }))).code).toBe('PART_EXISTS');
    await ok(save(s, 'update_part', { partId: a.id, partNumber: '90308200018', description: 'TXFR FOR M634VOC' }));
    expect(await prisma.part.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ partNumber: '90308200018', partKey: '90308200018', description: 'TXFR FOR M634VOC' });
    expect((await fails(save(s, 'update_part', { partId: a.id }))).code).toBe('NOTHING_TO_CHANGE');
    await ok(save(s, 'update_part', { partId: a.id, noLongerMade: true }));
    expect((await fails(save(s, 'create_job', { partId: a.id, quantity: 10, jobDate: today() }))).code).toBe('PART_NOT_MADE');
  });
});

describe('a part\'s usual bill of materials, and a job that starts from it', () => {
  async function world() {
    const s = await storekeeper();
    const c = await party(s, 'Medha Servo Drives');
    const wire = await mat(s, '22 SWG Copper Wire', 'KG'); const core = await mat(s, 'Ferrite Core E-30', 'NOS'); const tape = await mat(s, 'Insulation Tape', 'MTR');
    const p = await part(s, c, '90308200008', 'TXFR FOR M634VOC');
    return { s, c, wire, core, tape, p: p.id };
  }

  it('set_part_bom saves the usual list per piece, replaces it, and refuses a material twice', async () => {
    const { s, wire, core, p } = await world();
    expect((await fails(save(s, 'set_part_bom', { partId: p, lines: [{ materialId: wire, qtyPerPiece: 0.01 }, { materialId: wire, qtyPerPiece: 0.02 }] }))).code).toBe('DUPLICATE_LINE');
    await ok(save(s, 'set_part_bom', { partId: p, lines: [{ materialId: wire, qtyPerPiece: 0.0184 }, { materialId: core, qtyPerPiece: 2 }] }));
    await ok(save(s, 'set_part_bom', { partId: p, lines: [{ materialId: core, qtyPerPiece: 4 }] }));
    const got = await ok<{ bom: { material: string; perPieceText: string }[] }>(runTool(s, 'get_part', { partId: p }));
    expect(got.bom).toEqual([expect.objectContaining({ material: 'Ferrite Core E-30', perPieceText: '4 pcs' })]);
  });

  it('a job made for a part takes its customer and description from it; the part\'s BOM is offered on the BOM form; saving the job\'s BOM leaves the part\'s alone', async () => {
    const { s, c, wire, core, p } = await world();
    await ok(save(s, 'set_part_bom', { partId: p, lines: [{ materialId: wire, qtyPerPiece: 0.0184 }, { materialId: core, qtyPerPiece: 2 }] }));
    const job = await ok<{ id: string; number: string }>(save(s, 'create_job', { partId: p, quantity: 400, jobDate: today() }));
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row).toMatchObject({ partId: p, customerId: c, productDescription: 'TXFR FOR M634VOC', quantity: 400 });
    // the BOM form starts from the usual list, per piece
    const preview = await pendingActions.previewFor(s, 'set_job_bom', { jobId: job.id });
    expect(preview?.values.lines).toEqual(expect.arrayContaining([{ materialId: wire, qtyPerPiece: 0.0184 }, { materialId: core, qtyPerPiece: 2 }]));
    expect(preview?.info.join(' ')).toMatch(/usual materials for part 90308200008/);
    // this job needs one core more per piece: the job keeps its own list; the part's usual list does not move
    await ok(save(s, 'set_job_bom', { jobId: job.id, lines: [{ materialId: wire, qtyPerPiece: 0.0184 }, { materialId: core, qtyPerPiece: 3 }] }));
    expect(await prisma.partBomLine.findFirstOrThrow({ where: { partId: p, materialId: core } })).toMatchObject({ qtyPerPiece: expect.anything() });
    expect(Number((await prisma.partBomLine.findFirstOrThrow({ where: { partId: p, materialId: core } })).qtyPerPiece)).toBe(2);
    expect(Number((await prisma.jobBomLine.findFirstOrThrow({ where: { jobId: job.id, materialId: core } })).qtyPerPiece)).toBe(3);
  });

  it('the first BOM made for a part with no usual list becomes its usual list, and is said so', async () => {
    const { s, wire, tape, p } = await world();
    const job = await ok<{ id: string }>(save(s, 'create_job', { partId: p, quantity: 100, jobDate: today() }));
    const saved = await ok<{ keptForPart: string | null }>(save(s, 'set_job_bom', { jobId: job.id, lines: [{ materialId: wire, qtyPerPiece: 0.01 }, { materialId: tape, qtyPerPiece: 0.3 }] }));
    expect(saved.keptForPart).toBe('90308200008');
    expect(await prisma.partBomLine.count({ where: { partId: p } })).toBe(2);
    // the next job for that part starts from it
    const again = await ok<{ id: string }>(save(s, 'create_job', { partId: p, quantity: 50, jobDate: today() }));
    expect((await pendingActions.previewFor(s, 'set_job_bom', { jobId: again.id }))?.values.lines).toHaveLength(2);
  });

  it('a job with no part still works (jobs from before part numbers) but must say what is made; a part of another customer is refused', async () => {
    const { s, c, p } = await world();
    const legacy = await ok<{ id: string }>(save(s, 'create_job', { customerId: c, productDescription: 'old design', quantity: 5, jobDate: today() }));
    expect((await prisma.job.findUniqueOrThrow({ where: { id: legacy.id } })).partId).toBeNull();
    expect((await fails(save(s, 'create_job', { customerId: c, quantity: 5, jobDate: today() }))).code).toBe('PART_REQUIRED');
    const other = await party(s, 'Ashok Transformers');
    expect((await fails(save(s, 'create_job', { customerId: other, partId: p, quantity: 5, jobDate: today() }))).code).toBe('PART_CUSTOMER_MISMATCH');
  });
});

describe('a customer\'s order by part, and what is left to plan', () => {
  it('lines carry parts and pieces; the rate is the owner\'s alone; a part of another customer, a part twice, or a part already on the PO is refused', async () => {
    const s = await storekeeper(); const o = await owner();
    const medha = await party(s, 'Medha Servo Drives'); const ashok = await party(s, 'Ashok Transformers');
    const a = await part(s, medha, '90305600201', 'L9 (EXT) FOR M628VCUPS'); const b = await part(s, medha, '90308000101', 'L7 TXFR FOR M676ACUPS'); const z = await part(s, ashok, '1', 'x');
    expect((await fails(save(s, 'create_customer_po', { customerId: medha, number: '5100033466', lines: [{ partId: a.id, quantity: 492, rate: 148 }] }))).code).toBe('FORBIDDEN_ROLE');
    expect((await fails(save(s, 'create_customer_po', { customerId: medha, number: '5100033466', lines: [{ partId: z.id, quantity: 5 }] }))).code).toBe('PART_CUSTOMER_MISMATCH');
    expect((await fails(save(s, 'create_customer_po', { customerId: medha, number: '5100033466', lines: [{ partId: a.id, quantity: 5 }, { partId: a.id, quantity: 6 }] }))).code).toBe('DUPLICATE_LINE');
    expect(await prisma.customerPo.count()).toBe(0); // nothing was half-saved
    const po = await ok<{ id: string; lines: number }>(save(s, 'create_customer_po', { customerId: medha, number: '5100033466', lines: [{ partId: a.id, quantity: 492 }] }));
    expect(po.lines).toBe(1);
    // the PO is released item by item: the same PO again adds the new part
    const more = await ok<{ id: string; existing: boolean }>(save(s, 'create_customer_po', { customerId: medha, number: '5100033466', lines: [{ partId: b.id, quantity: 325 }] }));
    expect(more).toMatchObject({ id: po.id, existing: true });
    expect((await fails(save(s, 'create_customer_po', { customerId: medha, number: '5100033466', lines: [{ partId: b.id, quantity: 1 }] }))).code).toBe('LINE_EXISTS');
    // the owner may type the rate on the part that has none yet by a new PO
    await ok(save(o, 'create_customer_po', { customerId: medha, number: 'PO-2', lines: [{ partId: a.id, quantity: 100, rate: 148 }] }));
    const stored = await prisma.customerPoLine.findMany({ where: { customerPo: { number: 'PO-2' } } });
    expect(Number(stored[0]?.rate)).toBe(148);
  });

  it('a line may name its part by the number as typed (the assistant often does), and a wrong number is told in words', async () => {
    const s = await storekeeper(); const medha = await party(s, 'Medha Servo Drives');
    const a = await part(s, medha, '90305600201', 'L9');
    const po = await ok<{ id: string }>(save(s, 'create_customer_po', { customerId: medha, number: 'P9', lines: [{ partId: '90305600201', quantity: 10 }] }));
    expect((await prisma.customerPoLine.findFirstOrThrow({ where: { customerPoId: po.id } })).partId).toBe(a.id);
    const bad = await fails(save(s, 'create_customer_po', { customerId: medha, number: 'P10', lines: [{ partId: '90000000000', quantity: 10 }] }));
    expect(bad.message).toMatch(/Couldn't find the part 90000000000 for Medha Servo Drives/);
    // and the form holds the part itself, so its picker can show it
    const pv = await pendingActions.previewFor(s, 'create_customer_po', { customerId: medha, number: 'P11', lines: [{ partId: '90305600201', quantity: 5 }] });
    expect((pv as unknown as { values: { lines?: unknown } })?.values).toBeDefined();
  });

  it('get_customer_po shows ordered, in jobs and left to plan per part; jobs under the PO count, cancelled ones and samples do not; the rate shows to the owner only', async () => {
    const s = await storekeeper(); const o = await owner();
    const medha = await party(s, 'Medha Servo Drives');
    const a = await part(s, medha, '90305600201', 'L9 (EXT) FOR M628VCUPS');
    const po = await ok<{ id: string }>(save(o, 'create_customer_po', { customerId: medha, number: '5100033466', lines: [{ partId: a.id, quantity: 492, rate: 148 }] }));
    await ok(save(s, 'create_job', { partId: a.id, customerPoId: po.id, quantity: 200, jobDate: today() }));
    const cancelled = await ok<{ id: string }>(save(s, 'create_job', { partId: a.id, customerPoId: po.id, quantity: 50, jobDate: today() }));
    await ok(save(s, 'cancel_job', { jobId: cancelled.id, reason: 'duplicate' }));
    const mine = await ok<{ rows: { ordered: number; planned: number; left: number; rate: number | null }[]; totalValue: number | null }>(runTool(s, 'get_customer_po', { customerPoId: '5100033466', customerName: 'Medha Servo Drives' }));
    expect(mine.rows[0]).toMatchObject({ ordered: 492, planned: 200, left: 292, rate: null });
    expect(mine.totalValue).toBeNull();
    const his = await ok<{ rows: { rate: number | null; value: number | null }[]; totalValue: number | null }>(runTool(o, 'get_customer_po', { customerPoId: po.id }));
    expect(his.rows[0]).toMatchObject({ rate: 148, value: 72_816 });
    expect(his.totalValue).toBe(72_816);
    // the job form says how much is left on the PO, and offers it as the quantity
    const info = await pendingActions.previewFor(s, 'create_job', { partId: a.id, customerPoId: po.id });
    expect(info?.info.join(' ')).toMatch(/492 ordered, 200 already in jobs, 292 left to plan/);
    expect(info?.values.quantity).toBe(292);
  });

  it('what the customer pays never reaches the storekeeper: not in get_part, not in the list, not in the margin report', async () => {
    const s = await storekeeper(); const o = await owner();
    const medha = await party(s, 'Medha Servo Drives'); const a = await part(s, medha, '90305600201', 'x');
    await ok(save(o, 'create_customer_po', { customerId: medha, number: 'P1', lines: [{ partId: a.id, quantity: 10, rate: 148 }] }));
    const seen = await ok<{ orders: { rate: number | null }[] }>(runTool(s, 'get_part', { partId: a.id }));
    expect(seen.orders[0]?.rate).toBeNull();
    expect(JSON.stringify(await ok(runTool(s, 'list_customer_pos', {})))).not.toMatch(/148/);
    expect(await runTool(s, 'get_margin_by_part', {})).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
  });
});

describe('the margin by part (owner)', () => {
  it('closed jobs by part: cost a piece, the rate on the PO, the margin; a part with no rate shows its cost and says so', async () => {
    const s = await storekeeper(); const o = await owner();
    const c = await party(s, 'Medha Servo Drives');
    const a = await part(s, c, '90305600201', 'L9 TXFR'); const b = await part(s, c, '90308000101', 'L7 TXFR');
    const po = await ok<{ id: string }>(save(o, 'create_customer_po', { customerId: c, number: 'P1', lines: [{ partId: a.id, quantity: 500, rate: 148 }, { partId: b.id, quantity: 100 }] }));
    const ja = await ok<{ id: string }>(save(s, 'create_job', { partId: a.id, customerPoId: po.id, quantity: 400, jobDate: today() }));
    const jb = await ok<{ id: string }>(save(s, 'create_job', { partId: b.id, customerPoId: po.id, quantity: 100, jobDate: today() }));
    await prisma.job.update({ where: { id: ja.id }, data: { status: 'CLOSED', materialCost: 48_000, closedAt: new Date() } });   // ₹120 a piece
    await prisma.job.update({ where: { id: jb.id }, data: { status: 'CLOSED', materialCost: 9_000, closedAt: new Date() } });
    const r = await ok<{ rows: { partNumber: string; costPerPiece: number; ratePerPiece: number | null; margin: number | null; marginPct: number | null; rateMissing: boolean }[] }>(runTool(o, 'get_margin_by_part', {}));
    const ra = r.rows.find((x) => x.partNumber === '90305600201');
    expect(ra).toMatchObject({ costPerPiece: 120, ratePerPiece: 148, margin: 11_200, marginPct: 18.92, rateMissing: false });
    expect(r.rows.find((x) => x.partNumber === '90308000101')).toMatchObject({ costPerPiece: 90, ratePerPiece: null, margin: null, rateMissing: true });
    const only = await ok<{ rows: unknown[] }>(runTool(o, 'get_margin_by_part', { partNumber: '9030-5600' }));
    expect(only.rows).toHaveLength(1);
  });
});

describe('a material\'s own item code', () => {
  it('is typed, shown, searchable, and one code is one material (in any spacing and case)', async () => {
    const s = await storekeeper();
    const w = await ok<{ id: string }>(save(s, 'create_material', material('22 SWG Copper Wire', { uom: 'KG', itemCode: 'RM-0042' })));
    expect((await fails(save(s, 'create_material', material('Other Wire', { uom: 'KG', itemCode: ' rm 0042 ' })))).code).toBe('ITEM_CODE_EXISTS');
    const found = await ok<Rows<{ name: string; itemCode: string }>>(runTool(s, 'search_materials', { query: 'rm0042' }));
    expect(found.rows).toEqual([expect.objectContaining({ name: '22 SWG Copper Wire', itemCode: 'RM-0042' })]);
    const x = await ok<{ id: string }>(save(s, 'create_material', material('Varnish', { uom: 'LTR' })));
    await ok(save(s, 'update_material', { materialId: x.id, itemCode: 'RM-0099' }));
    expect((await fails(save(s, 'update_material', { materialId: x.id, itemCode: 'RM-0042' }))).code).toBe('ITEM_CODE_EXISTS');
    expect((await prisma.material.findUniqueOrThrow({ where: { id: x.id } })).itemCodeKey).toBe('rm0099');
    expect(w.id).toBeTruthy();
  });
});
