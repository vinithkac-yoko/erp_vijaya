import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pendingActions, registry, runTool } from '@/server/tools';
import { balance, makeUser, prisma, receive, resetDb } from './helpers/db';
import { fails, material, ok, owner, save, seedSettings, storekeeper } from './helpers/tools';

beforeEach(async () => { await resetDb(); await seedSettings(); });
afterAll(() => prisma.$disconnect());

type S = Awaited<ReturnType<typeof storekeeper>>;
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
type Rows<T = Record<string, unknown>> = { rows: T[] };

const party = async (s: S, name: string, role: 'SUPPLIER' | 'CUSTOMER' = 'CUSTOMER') => (await ok<{ id: string }>(save(s, 'create_party', { name, role, city: 'Chennai' }))).id;
const mat = async (s: S, name: string, uom: string, over: Record<string, unknown> = {}) => (await ok<{ id: string }>(save(s, 'create_material', material(name, { uom, ...over })))).id;

/** A job of 10 pieces: wire 0.5 kg each (5 kg) and cores 2 each (20), with stock to cover it. */
async function setup(s: S, o: { quantity?: number; wireStock?: number; coreStock?: number } = {}) {
  const customer = await party(s, 'Ashok Transformers');
  const wire = await mat(s, '22 SWG Copper Wire', 'KG'); const core = await mat(s, 'Ferrite Core E-30', 'NOS', { stockType: 'STANDING', minimumLevel: 10 }); const varnish = await mat(s, 'Varnish', 'LTR');
  if ((o.wireStock ?? 100) > 0) await receive(wire, o.wireStock ?? 100, 800);
  if ((o.coreStock ?? 100) > 0) await receive(core, o.coreStock ?? 100, 65);
  const job = await ok<{ id: string; number: string }>(save(s, 'create_job', { customerId: customer, productDescription: 'SMPS transformer', quantity: o.quantity ?? 10, jobDate: today() }));
  await ok(save(s, 'set_job_bom', { jobId: job.id, lines: [{ materialId: wire, qtyPerPiece: 0.5 }, { materialId: core, qtyPerPiece: 2 }] }));
  return { customer, wire, core, varnish, job };
}
const issue = (s: S, jobId: string, lines?: Record<string, unknown>[]) => save(s, 'issue_material', { jobId, ...(lines ? { lines } : {}) });
const jobRow = (id: string) => prisma.job.findUniqueOrThrow({ where: { id } });

describe('issuing material to a job (ACCEPTANCE §7)', () => {
  it('no lines gives out everything the BOM needs, in one go; the job becomes "material issued" (7.4)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    const r = await ok<{ lines: { material: string; quantity: number }[] }>(issue(s, x.job.id));
    expect(r.lines.map((l) => [l.material, l.quantity])).toEqual([['22 SWG Copper Wire', 5], ['Ferrite Core E-30', 20]]);
    expect(await jobRow(x.job.id)).toMatchObject({ status: 'MATERIAL_ISSUED' });
    expect(await balance(x.wire)).toMatchObject({ qty: 95 });
    const mv = await prisma.stockMovement.findMany({ where: { jobId: x.job.id, type: 'ISSUE' }, orderBy: { createdAt: 'asc' } });
    expect(mv).toHaveLength(2);
    expect(Number(mv[0]?.rate)).toBe(800); // the database sets the rate to the current average; nobody types it
    expect(Number(mv[0]?.value)).toBe(4000);
    expect(Number((await prisma.jobBomLine.findFirstOrThrow({ where: { jobId: x.job.id, materialId: x.wire } })).issuedQty)).toBe(5);
  });

  it('never issues twice: the second time there is nothing left (7.5)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    await ok(issue(s, x.job.id));
    const f = await fails(issue(s, x.job.id));
    expect(f.code).toBe('NOTHING_TO_ISSUE');
    expect(await prisma.stockMovement.count({ where: { type: 'ISSUE' } })).toBe(2);
  });

  it('always against a job: no job is refused, a job number or its end finds it (7.6)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    expect((await fails(save(s, 'issue_material', {}))).message).toBe('Which job?');
    await ok(issue(s, '1'));
    expect(await prisma.stockMovement.count({ where: { jobId: x.job.id, type: 'ISSUE' } })).toBe(2);
  });

  it('part of the BOM can be given out; more than the BOM needs must be marked as rework (7.7)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    await ok(issue(s, x.job.id, [{ materialId: x.wire, quantity: 2 }]));
    expect(await jobRow(x.job.id)).toMatchObject({ status: 'MATERIAL_ISSUED' });
    const over = await fails(issue(s, x.job.id, [{ materialId: x.wire, quantity: 5 }]));
    expect(over).toMatchObject({ code: 'OVER_BOM', field: 'lines' });
    expect(over.message).toContain('the BOM needs 3 kg more');
    await ok(issue(s, x.job.id, [{ materialId: x.wire, quantity: 3 }])); // exactly what is left
    const top = await ok<{ lines: { topUp: boolean }[] }>(issue(s, x.job.id, [{ materialId: x.wire, quantity: 2, topUp: true }]));
    expect(top.lines[0]?.topUp).toBe(true);
    expect((await prisma.stockMovement.findMany({ where: { reasonCode: 'TOP_UP' } }))).toHaveLength(1);
    // the variance report shows it as extra, not as a surprise
    const v = await ok<Rows<{ material: string; planned: number; used: number; difference: number; topUp: number }>>(runTool(s, 'get_job_bom_variance', { jobId: x.job.id }));
    expect(v.rows.find((r) => r.material === '22 SWG Copper Wire')).toMatchObject({ planned: 5, used: 7, difference: 2, topUp: 2 });
  });

  it('a material not on the BOM can only go out as marked rework; a material twice, zero and part pieces are refused', async () => {
    const s = await storekeeper(); const x = await setup(s);
    await receive(x.varnish, 10, 340);
    expect((await fails(issue(s, x.job.id, [{ materialId: x.varnish, quantity: 1 }]))).code).toBe('NOT_ON_BOM');
    await ok(issue(s, x.job.id, [{ materialId: x.varnish, quantity: 1, topUp: true }]));
    const v = await ok<Rows<{ material: string; planned: number; used: number; topUp: number }>>(runTool(s, 'get_job_bom_variance', { jobId: x.job.id }));
    expect(v.rows.find((r) => r.material === 'Varnish')).toMatchObject({ planned: 0, used: 1, topUp: 1 });
    expect((await fails(issue(s, x.job.id, [{ materialId: x.wire, quantity: 1 }, { materialId: x.wire, quantity: 1 }]))).code).toBe('DUPLICATE_LINE');
    expect((await fails(issue(s, x.job.id, [{ materialId: x.wire, quantity: 0 }]))).message).toBe('The quantity must be more than zero.');
    expect((await fails(issue(s, x.job.id, [{ materialId: x.core, quantity: 2.5 }]))).code).toBe('INVALID_QUANTITY');
  });

  it('a closed, cancelled or BOM-less job cannot be issued to', async () => {
    const s = await storekeeper(); const x = await setup(s);
    const bare = await ok<{ id: string }>(save(s, 'create_job', { customerId: x.customer, productDescription: 'No BOM yet', quantity: 5, jobDate: today() }));
    expect((await fails(issue(s, bare.id))).code).toBe('NO_BOM');
    await ok(save(s, 'cancel_job', { jobId: bare.id, reason: 'x' }));
    expect((await fails(issue(s, bare.id))).code).toBe('JOB_NOT_ISSUABLE');
  });

  it('stock may go negative: it is recorded, the owner is told, and nothing blocks or lectures (7.9, 7.10)', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s, { wireStock: 2 });
    const r = await ok<{ negatives: { material: string; balance: number }[] }>(issue(s, x.job.id));
    expect(r.negatives).toMatchObject([{ material: '22 SWG Copper Wire', balance: -3 }]);
    expect(await balance(x.wire)).toMatchObject({ qty: -3 });
    const told = await prisma.notification.findMany({ where: { userId: o.userId, type: 'NEGATIVE_STOCK_WARNING' } });
    expect(told).toMatchObject([{ body: expect.stringContaining('22 SWG Copper Wire is now -3 kg') }]);
    expect(await prisma.notification.count({ where: { userId: s.userId, type: 'NEGATIVE_STOCK_WARNING' } })).toBe(0);
    const tool = registry.get('issue_material');
    if (!tool || tool.kind !== 'write' || !tool.followUps) throw new Error('no follow-ups');
    const f = await tool.followUps({ session: s, read: (n, i) => runTool(s, n, i) }, {}, r);
    expect(f.facts[0]).toContain('22 SWG Copper Wire is now at -3 kg, below zero');
  });

  it('a standing material that falls below its minimum is said, the owner and the other storekeepers are told, and a PO is offered', async () => {
    const s = await storekeeper(); const o = await owner(); const other = await makeUser('STOREKEEPER'); const x = await setup(s, { coreStock: 25 });
    const r = await ok<{ belowMin: { material: string; balance: number; minimum: number; shortfall: number }[] }>(issue(s, x.job.id));
    expect(r.belowMin).toMatchObject([{ material: 'Ferrite Core E-30', balance: 5, minimum: 10, shortfall: 5 }]);
    expect(await prisma.notification.count({ where: { userId: o.userId, type: 'MIN_LEVEL_BREACH' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: other.id, type: 'MIN_LEVEL_BREACH' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: s.userId, type: 'MIN_LEVEL_BREACH' } })).toBe(0); // he did it and is told in the sentence
    const tool = registry.get('issue_material');
    if (!tool || tool.kind !== 'write' || !tool.followUps) throw new Error('no follow-ups');
    const f = await tool.followUps({ session: s, read: (n, i) => runTool(s, n, i) }, {}, r);
    expect(f.chips).toMatchObject([{ label: 'Raise a PO for Ferrite Core E-30', form: 'create_purchase_order', prefill: { lines: [{ quantity: 5 }] } }]);
  });

  it('the issue form lists every material with quantity and unit and the job, and warns what will go below zero (7.1)', async () => {
    const s = await storekeeper(); const x = await setup(s, { wireStock: 2 });
    const opened = await pendingActions.create(s, { tool: 'issue_material', origin: 'AGENT', input: { jobId: x.job.id } });
    if (!opened.ok) throw new Error('did not open');
    const card = await pendingActions.formCard(s, opened.data);
    expect(card.info?.[0]).toContain('Ashok Transformers · 10 pieces');
    expect(card.info).toContain('22 SWG Copper Wire: 5 kg · in stock 2 kg: it will go below zero');
    expect(card.info).toContain('Ferrite Core E-30: 20 pcs');
    expect(await prisma.stockMovement.count({ where: { type: 'ISSUE' } })).toBe(0); // opening a form changes nothing (7.2)
  });
});

describe('returning material and closing a job (ACCEPTANCE §8)', () => {
  it('leftovers go back at the current average rate; the user never types one (8.2)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    await ok(issue(s, x.job.id));
    const r = await ok<{ lines: { quantity: number }[] }>(save(s, 'return_material', { jobId: x.job.id, lines: [{ materialId: x.wire, quantity: 0.8 }, { materialId: x.core, quantity: 4 }], rate: 1 }));
    expect(r.lines).toHaveLength(2);
    const back = await prisma.stockMovement.findMany({ where: { type: 'RETURN' } });
    expect(back.map((m) => Number(m.rate)).sort()).toEqual([65, 800]);
    expect(await balance(x.wire)).toMatchObject({ qty: 95.8, rate: 800 });
  });

  it('only what was issued to that job can come back, and not more than was issued (8.6)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    await ok(issue(s, x.job.id, [{ materialId: x.wire, quantity: 5 }]));
    expect((await fails(save(s, 'return_material', { jobId: x.job.id, lines: [{ materialId: x.core, quantity: 1 }] }))).code).toBe('NOT_ISSUED_TO_JOB');
    const over = await fails(save(s, 'return_material', { jobId: x.job.id, lines: [{ materialId: x.wire, quantity: 5.5 }] }));
    expect(over.code).toBe('RETURN_EXCEEDS_ISSUE');
    expect(over.message).toContain('Only 5 kg of 22 SWG Copper Wire is out with');
    await ok(save(s, 'return_material', { jobId: x.job.id, lines: [{ materialId: x.wire, quantity: 5 }] }));
    expect((await fails(save(s, 'return_material', { jobId: x.job.id, lines: [{ materialId: x.wire, quantity: 0.1 }] }))).code).toBe('RETURN_EXCEEDS_ISSUE'); // already all back
  });

  it('closing asks "did anything come back?" first, never assumes nothing (8.1, 8.3, 8.7)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    await ok(issue(s, x.job.id));
    const ask = await fails(save(s, 'close_job', { jobId: x.job.id }));
    expect(ask).toMatchObject({ code: 'RETURN_ANSWER_REQUIRED', field: 'nothingReturned' });
    expect(ask.message).toContain('Did any material come back?');
    expect((await jobRow(x.job.id)).status).toBe('MATERIAL_ISSUED');
    await ok(save(s, 'return_material', { jobId: x.job.id, lines: [{ materialId: x.wire, quantity: 0.8 }, { materialId: x.core, quantity: 4 }] }));
    await ok(save(s, 'close_job', { jobId: x.job.id })); // something came back and is recorded: no need to say nothing did
    expect(await jobRow(x.job.id)).toMatchObject({ status: 'CLOSED' });
  });

  it('closing with "nothing came back" is accepted and fixes the cost at everything issued (8.7)', async () => {
    const s = await storekeeper(); const x = await setup(s);
    await ok(issue(s, x.job.id));
    await ok(save(s, 'close_job', { jobId: x.job.id, nothingReturned: true }));
    expect(Number((await jobRow(x.job.id)).materialCost)).toBe(5300); // 5 kg × 800 + 20 × 65
  });

  it('the cost is issued less returned, to the paisa, and per piece; only the owner is shown it (8.3, 8.8, 8.9)', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    await ok(issue(s, x.job.id));
    await ok(save(s, 'return_material', { jobId: x.job.id, lines: [{ materialId: x.wire, quantity: 0.8 }, { materialId: x.core, quantity: 4 }] }));
    const asKeeper = await ok<Record<string, unknown>>(save(s, 'close_job', { jobId: x.job.id }));
    expect(asKeeper).not.toHaveProperty('materialCost');
    expect(Number((await jobRow(x.job.id)).materialCost)).toBe(4400); // 5300 − 640 − 260
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'close_job' } });
    expect(ev.afterJson).toMatchObject({ materialCost: 4400, costPerPiece: 440, showCost: false });
    // the owner asks
    const g = await ok<{ costSoFar: number; job: { materialCost: number; costPerPiece: number } }>(runTool(o, 'get_job', { jobId: x.job.id }));
    expect(g.job).toMatchObject({ materialCost: 4400, costPerPiece: 440 });
    expect((await ok<{ job: { materialCost: number | null } }>(runTool(s, 'get_job', { jobId: x.job.id }))).job.materialCost).toBeNull();
  });

  it('what a closed job cost shows to the owner in his own saved card, not the storekeeper\'s', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    await ok(issue(o, x.job.id));
    await ok(save(o, 'close_job', { jobId: x.job.id, nothingReturned: true }));
    const tool = registry.get('close_job');
    if (!tool || tool.kind !== 'write') throw new Error('no tool');
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'close_job' } });
    expect(tool.describe(ev.afterJson as Record<string, unknown>).join('\n')).toContain('Material cost ₹5,300');
    void s;
  });

  it('a job that used more than 5% over its BOM is said at close and the owner is told', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    await ok(issue(s, x.job.id));
    await ok(issue(s, x.job.id, [{ materialId: x.wire, quantity: 2, topUp: true }]));
    await ok(save(s, 'return_material', { jobId: x.job.id, lines: [{ materialId: x.wire, quantity: 0.8 }] }));
    const r = await ok<{ overBom: { material: string; used: number; planned: number; overPct: number }[] }>(save(s, 'close_job', { jobId: x.job.id }));
    expect(r.overBom).toEqual([{ material: '22 SWG Copper Wire', unit: 'KG', planned: 5, used: 6.2, overPct: 24 }]);
    expect(await prisma.notification.findMany({ where: { userId: o.userId, type: 'JOB_VARIANCE' } })).toMatchObject([{ body: expect.stringContaining('24% over') }]);
  });

  it('refuses a return to a closed job (8.4), a second close, and closing a job with nothing issued', async () => {
    const s = await storekeeper(); const x = await setup(s);
    expect((await fails(save(s, 'close_job', { jobId: x.job.id }))).code).toBe('JOB_NOTHING_ISSUED');
    await ok(issue(s, x.job.id));
    await ok(save(s, 'close_job', { jobId: x.job.id, nothingReturned: true }));
    expect((await fails(save(s, 'return_material', { jobId: x.job.id, lines: [{ materialId: x.wire, quantity: 1 }] }))).code).toBe('JOB_CLOSED');
    expect((await fails(save(s, 'close_job', { jobId: x.job.id, nothingReturned: true }))).code).toBe('JOB_ALREADY_CLOSED');
    expect((await fails(issue(s, x.job.id))).code).toBe('JOB_NOT_ISSUABLE');
  });

  it('a sample job closes like any other, and its cost is marked as the company\'s', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    const sample = await ok<{ id: string }>(save(s, 'create_job', { customerId: x.customer, productDescription: 'Prototype', quantity: 2, jobDate: today(), type: 'SAMPLE', parentJobId: x.job.id }));
    await ok(save(s, 'set_job_bom', { jobId: sample.id, lines: [{ materialId: x.wire, qtyPerPiece: 0.5 }] }));
    await ok(issue(o, sample.id));
    const r = await ok<{ sample: boolean }>(save(o, 'close_job', { jobId: sample.id, nothingReturned: true }));
    expect(r.sample).toBe(true);
    const tool = registry.get('close_job');
    if (!tool || tool.kind !== 'write') throw new Error('no tool');
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'close_job' } });
    expect(tool.describe(ev.afterJson as Record<string, unknown>).join('\n')).toContain('a sample: its cost stays with the company');
  });

  it('the weighted-average check sequence: 100@800, 100@900 → 850; issue 50 → 850; return 10 → 850; 40@1000 → 880', async () => {
    const s = await storekeeper(); const customer = await party(s, 'Ashok Transformers'); const wire = await mat(s, '22 SWG Copper Wire', 'KG');
    await receive(wire, 100, 800); await receive(wire, 100, 900);
    expect(await balance(wire)).toMatchObject({ qty: 200, rate: 850 });
    const job = await ok<{ id: string }>(save(s, 'create_job', { customerId: customer, productDescription: 'x', quantity: 10, jobDate: today() }));
    await ok(save(s, 'set_job_bom', { jobId: job.id, lines: [{ materialId: wire, qtyPerPiece: 5 }] }));
    await ok(issue(s, job.id));
    expect(await balance(wire)).toMatchObject({ qty: 150, rate: 850 });
    await ok(save(s, 'return_material', { jobId: job.id, lines: [{ materialId: wire, quantity: 10 }] }));
    expect(await balance(wire)).toMatchObject({ qty: 160, rate: 850 });
    await receive(wire, 40, 1000);
    expect(await balance(wire)).toMatchObject({ qty: 200, rate: 880 });
  });
});

describe('scrap (ACCEPTANCE §10)', () => {
  async function scrapSetup(s: S) {
    const copper = await mat(s, 'Copper Scrap', 'KG', { isScrap: true });
    const buyer = await party(s, 'Murugan Metal Scrap');
    const a = await ok<{ id: string }>(save(s, 'create_job', { customerId: await party(s, 'Ashok Transformers'), productDescription: 'x', quantity: 5, jobDate: today() }));
    return { copper, buyer, job: a.id };
  }

  it('collected scrap goes in, optionally against the job it came from (10.1, 10.2)', async () => {
    const s = await storekeeper(); const x = await scrapSetup(s);
    await ok(save(s, 'record_scrap_in', { materialId: x.copper, quantity: 1.2, jobId: x.job }));
    await ok(save(s, 'record_scrap_in', { materialId: x.copper, quantity: 0.6 }));
    expect(await balance(x.copper)).toMatchObject({ qty: 1.8 });
    expect(await prisma.stockMovement.count({ where: { type: 'SCRAP_IN', jobId: x.job } })).toBe(1);
  });

  it('only a scrap material takes scrap', async () => {
    const s = await storekeeper(); const x = await scrapSetup(s); const wire = await mat(s, '22 SWG Copper Wire', 'KG');
    expect((await fails(save(s, 'record_scrap_in', { materialId: wire, quantity: 1 }))).code).toBe('NOT_SCRAP_MATERIAL');
    expect((await fails(save(s, 'record_scrap_sale', { materialId: wire, buyerId: x.buyer, quantity: 1, rate: 600, saleDate: today() }))).code).toBe('NOT_SCRAP_MATERIAL');
  });

  it('a sale is ₹930 for 1.5 kg at ₹620; selling more than was collected is allowed and flagged (10.3, 10.4)', async () => {
    const s = await storekeeper(); const x = await scrapSetup(s);
    await ok(save(s, 'record_scrap_in', { materialId: x.copper, quantity: 1.8 }));
    const sale = await ok<{ amount: number; overBy: number; number: string }>(save(s, 'record_scrap_sale', { materialId: x.copper, buyerId: x.buyer, quantity: 1.5, rate: 620, saleDate: today() }));
    expect(sale).toMatchObject({ amount: 930, overBy: 0 });
    expect(sale.number).toMatch(/^SCS-\d{4}-0001$/);
    const over = await ok<{ overBy: number; onHandBefore: number }>(save(s, 'record_scrap_sale', { materialId: x.copper, buyerId: x.buyer, quantity: 5, rate: 620, saleDate: today() }));
    expect(over).toMatchObject({ onHandBefore: 0.3, overBy: 4.7 });
    expect(await balance(x.copper)).toMatchObject({ qty: -4.7 });
  });

  it('the rate is typed, the buyer is a customer, the date is not the future', async () => {
    const s = await storekeeper(); const x = await scrapSetup(s); const sup = await party(s, 'Sundaram Ferrites', 'SUPPLIER');
    await ok(save(s, 'record_scrap_in', { materialId: x.copper, quantity: 2 }));
    expect((await fails(save(s, 'record_scrap_sale', { materialId: x.copper, buyerId: x.buyer, quantity: 1, saleDate: today() }))).message).toBe('Type the rate per unit.');
    expect((await fails(save(s, 'record_scrap_sale', { materialId: x.copper, buyerId: sup, quantity: 1, rate: 600, saleDate: today() }))).code).toBe('PARTY_WRONG_ROLE');
    expect((await fails(save(s, 'record_scrap_sale', { materialId: x.copper, buyerId: x.buyer, quantity: 1, rate: 600, saleDate: '2099-01-01' }))).code).toBe('INVALID_DATE');
  });

  it('the owner asks whether scrap sold matches scrap collected: 1.8 collected, 1.5 sold, 0.3 on hand (10.5); the storekeeper cannot', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await scrapSetup(s);
    await ok(save(s, 'record_scrap_in', { materialId: x.copper, quantity: 1.2, jobId: x.job }));
    await ok(save(s, 'record_scrap_in', { materialId: x.copper, quantity: 0.6 }));
    await ok(save(s, 'record_scrap_sale', { materialId: x.copper, buyerId: x.buyer, quantity: 1.5, rate: 620, saleDate: today() }));
    const r = await ok<Rows<{ collected: number; sold: number; onHand: number; saleValue: number; matches: boolean; byJob: { quantity: number }[] }>>(runTool(o, 'get_scrap_summary', {}));
    expect(r.rows[0]).toMatchObject({ collected: 1.8, sold: 1.5, onHand: 0.3, saleValue: 930, matches: true, byJob: [{ quantity: 1.2 }] });
    expect(await runTool(s, 'get_scrap_summary', {})).toMatchObject({ ok: false });
  });
});

describe('mistakes and corrections (ACCEPTANCE §14)', () => {
  async function wrongIssue(s: S) {
    const x = await setup(s);
    await ok(issue(s, x.job.id, [{ materialId: x.wire, quantity: 5 }]));
    const m = await prisma.stockMovement.findFirstOrThrow({ where: { type: 'ISSUE' } });
    return { ...x, movement: m };
  }

  it('the storekeeper cannot reverse or delete: it is the owner\'s (14.2, 14.3)', async () => {
    const s = await storekeeper(); const x = await wrongIssue(s);
    expect((await fails(save(s, 'reverse_movement', { movementId: x.movement.id, reason: 'mistake' }))).code).toBe('FORBIDDEN_ROLE');
    expect(registry.get('delete_movement')).toBeUndefined();
    expect(await prisma.stockMovement.count()).toBe(3); // the two receipts and the issue: nothing removed
  });

  it('the owner reverses it: both rows stay, the balance comes back, the job is open again, the storekeeper is told (14.4, 14.5)', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await wrongIssue(s);
    expect(await balance(x.wire)).toMatchObject({ qty: 95 });
    const r = await ok<{ balanceAfter: number; material: string }>(save(o, 'reverse_movement', { movementId: x.movement.id, reason: 'Issued to the wrong job' }));
    expect(r).toMatchObject({ material: '22 SWG Copper Wire', balanceAfter: 100 });
    expect(await balance(x.wire)).toMatchObject({ qty: 100, rate: 800 });
    const rows = await prisma.stockMovement.findMany({ where: { materialId: x.wire }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((m) => [m.type, m.direction])).toEqual([['RECEIPT', 'IN'], ['ISSUE', 'OUT'], ['REVERSAL', 'IN']]);
    expect(rows[2]).toMatchObject({ reversalOfId: x.movement.id, notes: 'Issued to the wrong job' });
    expect(Number(rows[2]?.rate)).toBe(800); // it comes back at the rate it went out
    expect(Number((await prisma.jobBomLine.findFirstOrThrow({ where: { jobId: x.job.id, materialId: x.wire } })).issuedQty)).toBe(0);
    expect((await jobRow(x.job.id)).status).toBe('OPEN');
    expect(await prisma.notification.findMany({ where: { userId: s.userId, type: 'MOVEMENT_REVERSED' } })).toMatchObject([{ body: expect.stringContaining('Issued to the wrong job') }]);
    // and now the right quantity can be issued (14.7)
    await ok(issue(s, x.job.id, [{ materialId: x.wire, quantity: 1 }]));
    expect(await balance(x.wire)).toMatchObject({ qty: 99 });
  });

  it('it can be reversed once only (14.6), a reversal cannot be reversed, goods sent back cannot', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await wrongIssue(s);
    await ok(save(o, 'reverse_movement', { movementId: x.movement.id, reason: 'x' }));
    expect((await fails(save(o, 'reverse_movement', { movementId: x.movement.id, reason: 'again' }))).code).toBe('ALREADY_REVERSED');
    const rev = await prisma.stockMovement.findFirstOrThrow({ where: { type: 'REVERSAL' } });
    expect((await fails(save(o, 'reverse_movement', { movementId: rev.id, reason: 'x' }))).code).toBe('NOT_REVERSIBLE');
    expect((await fails(save(o, 'reverse_movement', { movementId: x.movement.id }))).message).toBe('Say why.');
  });

  it('opening stock and count adjustments cannot be reversed: the next count corrects them', async () => {
    const s = await storekeeper(); const o = await owner();
    await mat(s, 'Varnish', 'LTR');
    await ok(save(s, 'start_stock_count', { countDate: today(), isOpening: true }));
    const line = await prisma.stockCountLine.findFirstOrThrow();
    await ok(save(s, 'submit_count_line', { stockCountLineId: line.id, countedQty: 10, unitRate: 340 }));
    await ok(save(s, 'submit_stock_count', {}));
    await ok(save(o, 'approve_stock_count', {}));
    const opening = await prisma.stockMovement.findFirstOrThrow({ where: { type: 'OPENING' } });
    const f = await fails(save(o, 'reverse_movement', { movementId: opening.id, reason: 'x' }));
    expect(f.code).toBe('NOT_REVERSIBLE');
    expect(f.message).toContain('The next count corrects them');
  });

  it('a receipt can be reversed (the PO goes back to open), but not once part of it was sent back', async () => {
    const s = await storekeeper(); const o = await owner();
    const sup = await party(s, 'Sundaram Ferrites', 'SUPPLIER'); const core = await mat(s, 'Ferrite Core E-30', 'NOS');
    const po = await ok<{ id: string }>(save(s, 'create_purchase_order', { supplierId: sup, lines: [{ materialId: core, quantity: 100, rate: 65 }] }));
    await ok(save(s, 'record_goods_receipt', { supplierId: sup, purchaseOrderId: po.id, receiptDate: today(), lines: [{ materialId: core, receivedQty: 100, rate: 65 }] }));
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe('RECEIVED');
    const rec = await prisma.stockMovement.findFirstOrThrow({ where: { type: 'RECEIPT' } });
    await ok(save(o, 'reverse_movement', { movementId: rec.id, reason: 'Wrong supplier recorded' }));
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe('APPROVED');
    expect(await balance(core)).toMatchObject({ qty: 0 });
    // a delivery with part sent back
    await ok(save(s, 'record_goods_receipt', { supplierId: sup, receiptDate: today(), lines: [{ materialId: core, receivedQty: 50, rejectedQty: 5, rejectionReason: 'Cracked', rate: 65 }] }));
    const rec2 = await prisma.stockMovement.findFirstOrThrow({ where: { type: 'RECEIPT', reversedBy: null } });
    expect((await fails(save(o, 'reverse_movement', { movementId: rec2.id, reason: 'x' }))).code).toBe('NOT_REVERSIBLE');
    const back = await prisma.stockMovement.findFirstOrThrow({ where: { type: 'REJECT_RETURN' } });
    expect((await fails(save(o, 'reverse_movement', { movementId: back.id, reason: 'x' }))).code).toBe('NOT_REVERSIBLE');
  });

  it('an issue on a closed job cannot be reversed: its cost is fixed', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await setup(s);
    await ok(issue(s, x.job.id));
    const m = await prisma.stockMovement.findFirstOrThrow({ where: { type: 'ISSUE' } });
    await ok(save(s, 'close_job', { jobId: x.job.id, nothingReturned: true }));
    expect((await fails(save(o, 'reverse_movement', { movementId: m.id, reason: 'x' }))).code).toBe('JOB_CLOSED');
  });

  it('the history shows both rows, newest first, with what was reversed; relative dates work; the storekeeper may read it', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await wrongIssue(s);
    await ok(save(o, 'reverse_movement', { movementId: x.movement.id, reason: 'x' }));
    const h = await ok<Rows<{ type: string; reversed: boolean; typeText: string; job: string | null; balanceAfter: number; by: string | null }> & { more: boolean }>(runTool(s, 'get_movement_history', { materialNames: ['22 swg copper wire'], from: '@today-7d', to: '@today' }));
    expect(h.rows.map((r) => r.type)).toEqual(['REVERSAL', 'ISSUE', 'RECEIPT']);
    expect(h.rows[0]).toMatchObject({ typeText: 'Reversal of given to a job', balanceAfter: 100 });
    expect(h.rows[1]).toMatchObject({ reversed: true, job: x.job.number, balanceAfter: 95 });
    expect((await ok<Rows>(runTool(s, 'get_movement_history', { jobId: x.job.number }))).rows).toHaveLength(2);
    expect((await fails(Promise.resolve(runTool(s, 'get_movement_history', { from: 'last week' })))).code).toBe('INVALID_INPUT');
  });

  it('the reversal form shows the entry, the balance now and after, and nothing changes until it is pressed (14.4)', async () => {
    const s = await storekeeper(); const o = await owner(); const x = await wrongIssue(s);
    const opened = await pendingActions.create(o, { tool: 'reverse_movement', origin: 'AGENT', input: { movementId: x.movement.id } });
    if (!opened.ok) throw new Error('did not open');
    const card = await pendingActions.formCard(o, opened.data);
    expect(card.info?.[0]).toContain('5 kg 22 SWG Copper Wire · given to a job');
    expect(card.info?.[1]).toBe('Balance now 95 kg; after the reversal 100 kg.');
    expect(await prisma.stockMovement.count({ where: { type: 'REVERSAL' } })).toBe(0);
  });
});
