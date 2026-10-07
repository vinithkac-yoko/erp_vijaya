import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pendingActions, runTool, registry } from '@/server/tools';
import { issue, prisma, receive, resetDb } from './helpers/db';
import { fails, material, ok, owner, save, seedSettings, storekeeper } from './helpers/tools';

beforeEach(async () => { await resetDb(); await seedSettings(); });
afterAll(() => prisma.$disconnect());

type S = Awaited<ReturnType<typeof storekeeper>>;
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
type Rows<T = Record<string, unknown>> = { rows: T[] };

async function party(s: S, name: string, role: 'CUSTOMER' | 'SUPPLIER' | 'BOTH' = 'CUSTOMER') {
  return (await ok<{ id: string }>(save(s, 'create_party', { name, role, city: 'Chennai' }))).id;
}
async function mat(s: S, name: string, uom: string, over: Record<string, unknown> = {}) {
  return (await ok<{ id: string }>(save(s, 'create_material', material(name, { uom, ...over })))).id;
}
async function job(s: S, customerId: string, over: Record<string, unknown> = {}) {
  return ok<{ id: string; number: string }>(save(s, 'create_job', { customerId, productDescription: 'SMPS transformer 12V 2A', quantity: 500, jobDate: today(), ...over }));
}
/** ACCEPTANCE 4.2's five materials. Ferrite cores: 18 in stock, a minimum of 50. */
async function five(s: S) {
  const m = {
    wire: await mat(s, '22 SWG Copper Wire', 'KG'), core: await mat(s, 'Ferrite Core E-30', 'NOS', { stockType: 'STANDING', minimumLevel: 50 }),
    bobbin: await mat(s, 'Bobbin Type-B', 'NOS'), tape: await mat(s, 'Insulation Tape', 'MTR'), varnish: await mat(s, 'Varnish', 'LTR'),
  };
  await receive(m.core, 18, 65);
  return m;
}
const bom = (m: Awaited<ReturnType<typeof five>>) => [
  { materialId: m.wire, qtyPerPiece: 0.0184 }, { materialId: m.core, qtyPerPiece: 2 }, { materialId: m.bobbin, qtyPerPiece: 1 },
  { materialId: m.tape, qtyPerPiece: 0.3 }, { materialId: m.varnish, qtyPerPiece: 0.005 },
];

describe('customer POs (ACCEPTANCE 3.2–3.4)', () => {
  it('records a PO for a customer picked from the list, and offers a job under it', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers');
    const r = await ok<{ id: string; existing: boolean }>(save(s, 'create_customer_po', { customerId: c, number: 'AT/2627/118', poDate: today() }));
    expect(r.existing).toBe(false);
    const po = await prisma.customerPo.findUniqueOrThrow({ where: { id: r.id } });
    expect(po).toMatchObject({ number: 'AT/2627/118', customerId: c });
    expect(await prisma.party.count()).toBe(1); // a PO never creates a business
  });

  it('the same PO again is recognised, not duplicated, in any case or spacing (3.3)', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers');
    const first = await ok<{ id: string }>(save(s, 'create_customer_po', { customerId: c, number: 'AT/2627/118' }));
    const again = await ok<{ id: string; existing: boolean }>(save(s, 'create_customer_po', { customerId: c, number: ' at/2627/118 ' }));
    expect(again).toMatchObject({ id: first.id, existing: true });
    expect(await prisma.customerPo.count()).toBe(1);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'create_customer_po', action: 'REUSE' } });
    expect(ev.afterJson).toMatchObject({ existing: true });
  });

  it('works from the customer\'s name, as the assistant sends it; refuses a supplier, and an unknown name with suggestions', async () => {
    const s = await storekeeper(); await party(s, 'Southern Railway'); await party(s, 'Sundaram Ferrites', 'SUPPLIER');
    await ok(save(s, 'create_customer_po', { customerName: 'Southern Railway', number: 'SRSW-OP-44' }));
    expect(await prisma.customerPo.count()).toBe(1);
    expect((await fails(save(s, 'create_customer_po', { customerName: 'Sundaram Ferrites', number: 'X1' }))).code).toBe('PARTY_WRONG_ROLE');
    const nf = await fails(save(s, 'create_customer_po', { customerName: 'Southern Railways Ltd Chennai', number: 'X2' }));
    expect(nf.code).toBe('PARTY_NOT_FOUND');
    expect((await fails(save(s, 'create_customer_po', { customerName: 'Nobody At All', number: 'X3' }))).message).toContain('Add them as a customer first');
  });

  it('lists a customer\'s POs with how many jobs run under each (an open PO releases item by item)', async () => {
    const s = await storekeeper(); const c = await party(s, 'Southern Railway');
    const po = await ok<{ id: string }>(save(s, 'create_customer_po', { customerId: c, number: 'SRSW-OP-44' }));
    await job(s, c, { customerPoId: po.id }); await job(s, c, { customerPoId: po.id, productDescription: 'Second item' });
    const l = await ok<Rows<{ number: string; jobs: number }>>(runTool(s, 'list_customer_pos', { customerName: 'Southern Railway' }));
    expect(l.rows).toMatchObject([{ number: 'SRSW-OP-44', jobs: 2 }]);
  });
});

describe('jobs (ACCEPTANCE 4.1, 4.5, 4.11–4.13)', () => {
  it('creates a job with a number from the financial year, and a PO belongs to its own customer', async () => {
    const s = await storekeeper(); const a = await party(s, 'Ashok Transformers'); const b = await party(s, 'Brightline LED');
    const po = await ok<{ id: string }>(save(s, 'create_customer_po', { customerId: a, number: 'AT/2627/118' }));
    const j = await job(s, a, { customerPoId: po.id });
    expect(j.number).toMatch(/^JOB-\d{4}-0001$/);
    expect((await job(s, b)).number).toMatch(/-0002$/);
    expect((await fails(save(s, 'create_job', { customerId: b, customerPoId: po.id, productDescription: 'x', quantity: 5, jobDate: today() }))).code).toBe('CUSTOMER_PO_MISMATCH');
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: j.id } });
    expect(ev.afterJson).toMatchObject({ customer: 'Ashok Transformers', quantity: 500, po: 'AT/2627/118' });
  });

  it('refuses zero pieces, part pieces, and a supplier as the customer (4.13)', async () => {
    const s = await storekeeper(); const c = await party(s, 'SunGrid Solar'); const sup = await party(s, 'Sundaram Ferrites', 'SUPPLIER');
    const zero = await fails(save(s, 'create_job', { customerId: c, productDescription: 'x', quantity: 0, jobDate: today() }));
    expect(zero).toMatchObject({ code: 'INVALID_INPUT', message: 'The quantity must be more than zero.', field: 'quantity' });
    expect((await fails(save(s, 'create_job', { customerId: c, productDescription: 'x', quantity: 2.5, jobDate: today() }))).message).toBe('Pieces are whole numbers.');
    expect((await fails(save(s, 'create_job', { customerId: sup, productDescription: 'x', quantity: 5, jobDate: today() }))).code).toBe('PARTY_WRONG_ROLE');
    expect((await fails(save(s, 'create_job', { customerId: c, productDescription: 'x', quantity: 5, jobDate: today(), dueDate: '2020-01-01' }))).code).toBe('INVALID_DATE');
    expect(await prisma.job.count()).toBe(0);
  });

  it('a very large number of pieces is asked about once (24.16)', async () => {
    const s = await storekeeper(); const c = await party(s, 'SunGrid Solar');
    const f = await fails(save(s, 'create_job', { customerId: c, productDescription: 'x', quantity: 1_000_000, jobDate: today() }));
    expect(f).toMatchObject({ code: 'CONFIRM_UNUSUAL_QUANTITY', field: 'quantity' });
    await ok(save(s, 'create_job', { customerId: c, productDescription: 'x', quantity: 1_000_000, jobDate: today(), confirmUnusual: true }));
  });

  it('a sample needs its main job, and is linked to it (4.11, 4.12)', async () => {
    const s = await storekeeper(); const c = await party(s, 'Southern Railway');
    expect((await fails(save(s, 'create_job', { customerId: c, productDescription: 'Sample', quantity: 5, jobDate: today(), type: 'SAMPLE' }))).code).toBe('PARENT_REQUIRED');
    const main = await job(s, c, { quantity: 300, productDescription: 'Signal isolation transformer' });
    const sample = await job(s, c, { quantity: 5, type: 'SAMPLE', parentJobId: main.id, productDescription: 'Prototype' });
    expect(await prisma.job.findUniqueOrThrow({ where: { id: sample.id } })).toMatchObject({ type: 'SAMPLE', parentJobId: main.id });
    expect((await fails(save(s, 'create_job', { customerId: c, productDescription: 's', quantity: 1, jobDate: today(), type: 'SAMPLE', parentJobId: sample.id }))).code).toBe('PARENT_IS_SAMPLE');
  });

  it('a repeat order is a new job with no BOM: nothing is copied (4.9)', async () => {
    const s = await storekeeper(); const c = await party(s, 'Brightline LED'); const m = await five(s);
    const first = await job(s, c, { quantity: 1200, productDescription: 'LED driver transformer' });
    await ok(save(s, 'set_job_bom', { jobId: first.id, lines: bom(m) }));
    const again = await job(s, c, { quantity: 1200, productDescription: 'LED driver transformer' });
    expect(await prisma.jobBomLine.count({ where: { jobId: again.id } })).toBe(0);
  });
});

describe('the BOM (ACCEPTANCE 4.2–4.4, 4.7, 4.10)', () => {
  it('stores per piece and works out the total: 9.2 kg, 1000 cores, 500 bobbins, 150 m, 2.5 L (4.2)', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers'); const m = await five(s); const j = await job(s, c);
    const r = await ok<{ lines: { material: string; each: string; total: string }[] }>(save(s, 'set_job_bom', { jobId: j.id, lines: bom(m) }));
    expect(r.lines.map((l) => `${l.material} — ${l.each} each → ${l.total}`)).toEqual([
      '22 SWG Copper Wire — 18.4 g each → 9.2 kg', 'Bobbin Type-B — 1 pcs each → 500 pcs', 'Ferrite Core E-30 — 2 pcs each → 1,000 pcs',
      'Insulation Tape — 0.3 m each → 150 m', 'Varnish — 5 ml each → 2.5 L',
    ]);
    const wire = await prisma.jobBomLine.findFirstOrThrow({ where: { jobId: j.id, materialId: m.wire } });
    expect(Number(wire.qtyPerPiece)).toBe(0.0184);
    expect(Number(wire.requiredQty)).toBe(9.2);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'set_job_bom' } });
    expect(JSON.stringify(ev.afterJson)).not.toMatch(/"id"|materialId/); // names and numbers, no ids
  });

  it('then the shortage check says what is short: cores need 1000, have 18, short 982 (4.3, 4.4)', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers'); const m = await five(s); const j = await job(s, c);
    await ok(save(s, 'set_job_bom', { jobId: j.id, lines: bom(m) }));
    const sh = await ok<{ anyShort: boolean; rows: { material: string; needed: number; inStock: number; short: number }[] }>(runTool(s, 'check_job_shortage', { jobId: j.id }));
    expect(sh.anyShort).toBe(true);
    expect(sh.rows.find((r) => r.material === 'Ferrite Core E-30')).toMatchObject({ needed: 1000, inStock: 18, short: 982 });
    expect(sh.rows.filter((r) => r.short > 0).map((r) => r.material)).toEqual(['22 SWG Copper Wire', 'Bobbin Type-B', 'Ferrite Core E-30', 'Insulation Tape', 'Varnish']); // nothing else in stock yet
    // the server draws the table and offers the purchase order for exactly the shortfall, rate left out (4.4)
    const tool = registry.get('set_job_bom');
    if (!tool || tool.kind !== 'write' || !tool.followUps) throw new Error('no follow-ups');
    const f = await tool.followUps({ session: s, read: (n, i) => runTool(s, n, i) }, {}, { jobId: j.id });
    expect(f.cards?.[0]).toMatchObject({ kind: 'table', note: '5 short.' });
    expect(f.chips[0]).toMatchObject({ label: 'Raise a PO for the shortfall', form: 'create_purchase_order' });
    const core = (f.chips[0] as unknown as { prefill: { lines: { materialId: string; quantity: number; rate?: number }[] } }).prefill.lines.find((l) => l.materialId === m.core);
    expect(core).toEqual({ materialId: m.core, quantity: 982 });
    expect(f.facts[0]).toContain('Ferrite Core E-30 needs 1,000 pcs, in stock 18 pcs, short 982 pcs');
  });

  it('nothing short offers to issue material', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers'); const m = await five(s); const j = await job(s, c, { quantity: 5 });
    await receive(m.wire, 5, 800); await receive(m.core, 100, 65); await receive(m.bobbin, 100, 9); await receive(m.tape, 100, 3); await receive(m.varnish, 5, 340);
    await ok(save(s, 'set_job_bom', { jobId: j.id, lines: bom(m) }));
    const sh = await ok<{ anyShort: boolean }>(runTool(s, 'check_job_shortage', { jobId: j.id }));
    expect(sh.anyShort).toBe(false);
  });

  it('can be changed while nothing is issued, and the new total is confirmed (4.10)', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers'); const m = await five(s); const j = await job(s, c);
    await ok(save(s, 'set_job_bom', { jobId: j.id, lines: bom(m) }));
    const lines = bom(m); lines[0] = { materialId: m.wire, qtyPerPiece: 0.019 };
    const r = await ok<{ lines: { material: string; each: string; total: string }[] }>(save(s, 'set_job_bom', { jobId: j.id, lines }));
    expect(r.lines.find((l) => l.material === '22 SWG Copper Wire')).toMatchObject({ each: '19 g', total: '9.5 kg' });
    expect(await prisma.jobBomLine.count({ where: { jobId: j.id } })).toBe(5); // replaced, not added to
    expect((await prisma.auditEvent.findMany({ where: { toolName: 'set_job_bom' }, orderBy: { createdAt: 'asc' } })).map((e) => e.action)).toEqual(['CREATE', 'UPDATE']);
  });

  it('is refused once material has been issued: a top-up is the way (JOB_NOT_OPEN)', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers'); const m = await five(s); const j = await job(s, c);
    await ok(save(s, 'set_job_bom', { jobId: j.id, lines: bom(m) }));
    await prisma.job.update({ where: { id: j.id }, data: { status: 'MATERIAL_ISSUED' } });
    const f = await fails(save(s, 'set_job_bom', { jobId: j.id, lines: bom(m) }));
    expect(f).toMatchObject({ code: 'JOB_NOT_OPEN', field: 'jobId' });
    expect(f.message).toContain('top-up');
    expect(await prisma.jobBomLine.count({ where: { jobId: j.id } })).toBe(5);
  });

  it('refuses a material twice, zero, 2.5 cores each, and asks once about a tiny number (24.6, 24.7)', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers'); const m = await five(s); const j = await job(s, c);
    expect((await fails(save(s, 'set_job_bom', { jobId: j.id, lines: [{ materialId: m.wire, qtyPerPiece: 1 }, { materialId: m.wire, qtyPerPiece: 2 }] }))).code).toBe('DUPLICATE_LINE');
    expect((await fails(save(s, 'set_job_bom', { jobId: j.id, lines: [{ materialId: m.wire, qtyPerPiece: 0 }] }))).message).toBe('The quantity must be more than zero.');
    const frac = await fails(save(s, 'set_job_bom', { jobId: j.id, lines: [{ materialId: m.core, qtyPerPiece: 2.5 }] }));
    expect(frac.message).toContain('whole pieces');
    const tiny = await fails(save(s, 'set_job_bom', { jobId: j.id, lines: [{ materialId: m.wire, qtyPerPiece: 0.00005 }] }));
    expect(tiny.code).toBe('CONFIRM_UNUSUAL_QUANTITY');
    expect((await fails(save(s, 'set_job_bom', { jobId: j.id, lines: [{ materialId: m.wire, qtyPerPiece: 0.0000001 }] }))).message).toContain('smaller than the system can keep');
    await ok(save(s, 'set_job_bom', { jobId: j.id, lines: [{ materialId: m.wire, qtyPerPiece: 0.00005 }], confirmUnusual: true }));
    await prisma.jobBomLine.deleteMany();
    expect((await fails(save(s, 'set_job_bom', { jobId: j.id, lines: [] }))).message).toBe('Add at least one material.');
    expect(await prisma.jobBomLine.count()).toBe(0);
  });
});

describe('looking at jobs (ACCEPTANCE 4.14)', () => {
  it('finds a job by its full number or just the end of it, and shows the BOM with required quantities', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers'); const m = await five(s); const j = await job(s, c);
    await ok(save(s, 'set_job_bom', { jobId: j.id, lines: bom(m) }));
    for (const ref of [j.number, '1', 'job 1', j.number.toLowerCase()]) {
      const g = await ok<{ job: { number: string; quantity: number; status: string }; bom: { material: string; required: number }[] }>(runTool(s, 'get_job', { jobId: ref }));
      expect(g.job).toMatchObject({ number: j.number, quantity: 500, status: 'OPEN' });
      expect(g.bom.find((b) => b.material === 'Varnish')?.required).toBe(2.5);
    }
    expect((await fails(Promise.resolve(runTool(s, 'get_job', { jobId: '99' })))).code).toBe('NOT_FOUND');
  });

  it('job cost is the owner\'s: the storekeeper\'s copy of a closed job has none', async () => {
    const s = await storekeeper(); const o = await owner(); const c = await party(s, 'Ashok Transformers'); const j = await job(s, c);
    await prisma.job.update({ where: { id: j.id }, data: { status: 'CLOSED', materialCost: 12345, closedAt: new Date() } });
    const sk = await ok<Rows<{ materialCost: number | null; costPerPiece: number | null }>>(runTool(s, 'list_jobs', {}));
    const ow = await ok<Rows<{ materialCost: number | null; costPerPiece: number | null }>>(runTool(o, 'list_jobs', {}));
    expect(sk.rows[0]).toMatchObject({ materialCost: null, costPerPiece: null });
    expect(ow.rows[0]).toMatchObject({ materialCost: 12345, costPerPiece: 24.69 });
    expect((await ok<{ costSoFar: number | null }>(runTool(s, 'get_job', { jobId: j.id }))).costSoFar).toBeNull();
  });

  it('filters by status and customer; open jobs are what the chip asks for', async () => {
    const s = await storekeeper(); const a = await party(s, 'Ashok Transformers'); const b = await party(s, 'Brightline LED');
    const j1 = await job(s, a); await job(s, b);
    await ok(save(s, 'cancel_job', { jobId: j1.id, reason: 'Customer withdrew' }));
    expect((await ok<Rows>(runTool(s, 'list_jobs', { status: 'OPEN' }))).rows).toHaveLength(1);
    expect((await ok<Rows>(runTool(s, 'list_jobs', { customerId: a }))).rows).toHaveLength(1);
    expect((await ok<Rows>(runTool(s, 'list_jobs', { status: 'CANCELLED', from: '2020-01-01' }))).rows).toHaveLength(1);
  });

  it('planned against used reads the BOM and the running issued and returned totals', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers'); const m = await five(s); const j = await job(s, c);
    await ok(save(s, 'set_job_bom', { jobId: j.id, lines: bom(m) }));
    await prisma.jobBomLine.updateMany({ where: { jobId: j.id, materialId: m.wire }, data: { issuedQty: 10, returnedQty: 0.5 } });
    const v = await ok<Rows<{ material: string; planned: number; used: number; difference: number; differencePct: number }>>(runTool(s, 'get_job_bom_variance', { jobId: j.id }));
    expect(v.rows.find((r) => r.material === '22 SWG Copper Wire')).toMatchObject({ planned: 9.2, used: 9.5, difference: 0.3, differencePct: 3.26 });
  });
});

describe('cancelling a job', () => {
  it('is allowed with nothing issued, needs a reason, and keeps the job in the list as cancelled', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers'); const j = await job(s, c);
    expect((await fails(save(s, 'cancel_job', { jobId: j.id }))).message).toBe('Say why.');
    await ok(save(s, 'cancel_job', { jobId: j.id, reason: 'Customer withdrew' }));
    expect(await prisma.job.findUniqueOrThrow({ where: { id: j.id } })).toMatchObject({ status: 'CANCELLED' });
    expect((await fails(save(s, 'cancel_job', { jobId: j.id, reason: 'again' }))).code).toBe('JOB_ALREADY_CANCELLED');
    expect((await fails(save(s, 'set_job_bom', { jobId: j.id, lines: [{ materialId: await mat(s, 'Varnish', 'LTR'), qtyPerPiece: 1 }] }))).code).toBe('JOB_NOT_OPEN');
  });

  it('is refused once material has been issued, and while a sample hangs under it', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers'); const m = await five(s);
    const j = await job(s, c); await receive(m.wire, 50, 800); await issue(m.wire, j.id, 5);
    expect((await fails(save(s, 'cancel_job', { jobId: j.id, reason: 'x' }))).code).toBe('JOB_HAS_ISSUES');
    const main = await job(s, c); await job(s, c, { type: 'SAMPLE', parentJobId: main.id, quantity: 2 });
    expect((await fails(save(s, 'cancel_job', { jobId: main.id, reason: 'x' }))).code).toBe('JOB_HAS_SAMPLES');
  });
});

describe('forms open with what the tool knows', () => {
  it('the BOM form opens on the job, with its pieces and the BOM it already has', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers'); const m = await five(s); const j = await job(s, c);
    await ok(save(s, 'set_job_bom', { jobId: j.id, lines: bom(m).slice(0, 2) }));
    const opened = await pendingActions.create(s, { tool: 'set_job_bom', origin: 'AGENT', input: { jobId: j.id } });
    if (!opened.ok) throw new Error('form did not open');
    const card = await pendingActions.formCard(s, opened.data);
    expect(card.values).toMatchObject({ jobId: j.id, jobQuantity: 500 });
    expect(card.values.lines).toHaveLength(2);
    expect(card.info?.[0]).toContain('Ashok Transformers · 500 pieces');
    expect(card.info?.join(' ')).toContain('Saving replaces it');
  });

  it('a chip\'s starting values are cleaned like the assistant\'s but are not flagged as the assistant\'s; rates never get in', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers'); const j = await job(s, c);
    const opened = await pendingActions.create(s, { tool: 'set_job_bom', origin: 'LAUNCHER', input: { jobId: j.id, junk: 1 }, fromChip: true });
    if (!opened.ok) throw new Error('form did not open');
    expect(opened.data).toMatchObject({ assisted: false, input: { jobId: j.id } });
    expect(opened.data.dropped).toContain('junk');
  });

  it('the job form carries today\'s date, and a PO named alone brings its customer', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers');
    const po = await ok<{ id: string }>(save(s, 'create_customer_po', { customerId: c, number: 'AT/2627/118' }));
    const opened = await pendingActions.create(s, { tool: 'create_job', origin: 'AGENT', input: { customerPoId: po.id } });
    if (!opened.ok) throw new Error('form did not open');
    const card = await pendingActions.formCard(s, opened.data);
    expect(card.values).toMatchObject({ jobDate: today(), type: 'PRODUCTION', customerId: c });
  });

  it('a customer PO form opened with a name finds the customer', async () => {
    const s = await storekeeper(); const c = await party(s, 'Ashok Transformers');
    const opened = await pendingActions.create(s, { tool: 'create_customer_po', origin: 'AGENT', input: { customerName: 'Ashok Transformers', number: 'AT/2627/118' } });
    if (!opened.ok) throw new Error('form did not open');
    expect((await pendingActions.formCard(s, opened.data)).values).toMatchObject({ customerId: c, number: 'AT/2627/118' });
  });
});
