import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runTool } from '@/server/tools';
import { addLine, approveCount, makeCount, makeJob, makeMaterial, makeParty, prisma, receive, resetDb, setCountStatus } from './helpers/db';
import { fails, material, ok, owner, save, seedSettings, storekeeper } from './helpers/tools';

beforeEach(async () => { await resetDb(); await seedSettings(); });
afterAll(() => prisma.$disconnect());

const day = (ymd: string) => new Date(`${ymd}T00:00:00+05:30`);
type Leak = { rows: { material: string; timesCounted: number; timesMismatched: number; netDifference: number; totalShortage: number; varianceValue: number; unexplainedCount: number; reasons: string }[]; totals: { unexplained: number; mismatches: number; varianceValue: number }; counts: number; notFound: string[] };
const leak = async (input: object = {}) => ok<Leak>(runTool(await owner(), 'get_leak_report', input));

/** Copper 100 kg at ₹800 and bobbins 652 at ₹9, then two approved monthly counts with differences (ACCEPTANCE §11, §12). */
async function twoMonths() {
  const copper = await makeMaterial({ name: '22 SWG Copper Wire', uom: 'KG' });
  const bobbin = await makeMaterial({ name: 'Bobbin Type-B', uom: 'NOS' });
  await receive(copper.id, 100, 800);
  await receive(bobbin.id, 652, 9);
  const sep = await makeCount({ countDate: day('2026-09-30') });
  await addLine(sep.id, copper.id, { system: 100, counted: 98, reason: 'MISSING' });
  await addLine(sep.id, bobbin.id, { system: 652, counted: 612, reason: 'UNEXPLAINED' });
  await approveCount(sep.id);
  const oct = await makeCount({ countDate: day('2026-10-31') });
  await addLine(oct.id, copper.id, { system: 98, counted: 97 });
  await addLine(oct.id, bobbin.id, { system: 612, counted: 612 });
  await approveCount(oct.id);
  return { copper, bobbin, sep, oct };
}

describe('get_leak_report (ACCEPTANCE 12.1–12.3, 12.6)', () => {
  it('ranks by rupee value, leaves out the opening count, and counts what nobody explained', async () => {
    const { copper } = await twoMonths();
    // the opening count: every material "differs" from zero on day one; none of that is leakage
    const opening = await makeCount({ isOpening: true, countDate: day('2026-08-01') });
    await addLine(opening.id, copper.id, { system: 0, counted: 145, rate: 812 });
    await approveCount(opening.id);

    const r = await leak();
    expect(r.rows.map((x) => x.material)).toEqual(['22 SWG Copper Wire', 'Bobbin Type-B']);
    expect(r.rows[0]).toMatchObject({ timesCounted: 2, timesMismatched: 2, netDifference: -3, totalShortage: 3, varianceValue: 2400, unexplainedCount: 1, reasons: "Missing ×1, Don't know ×1" });
    expect(r.rows[1]).toMatchObject({ timesCounted: 2, timesMismatched: 1, totalShortage: 40, varianceValue: 360, unexplainedCount: 1 });
    expect(r.totals).toMatchObject({ unexplained: 2, mismatches: 3, varianceValue: 2760 });
    expect(r.counts).toBe(2);
  });

  it('says the same as the database view', async () => {
    await twoMonths();
    const view = await prisma.$queryRaw<{ material_name: string; times_mismatched: bigint; total_variance_value: string; unexplained_count: bigint }[]>`SELECT material_name, times_mismatched, total_variance_value, unexplained_count FROM v_material_leak ORDER BY total_variance_value DESC`;
    const r = await leak();
    expect(r.rows.map((x) => [x.material, x.timesMismatched, x.varianceValue, x.unexplainedCount])).toEqual(view.map((v) => [v.material_name, Number(v.times_mismatched), Number(v.total_variance_value), Number(v.unexplained_count)]));
  });

  it('a period narrows it: this month only', async () => {
    await twoMonths();
    const r = await leak({ from: '2026-10-01' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ material: '22 SWG Copper Wire', timesCounted: 1, unexplainedCount: 1, varianceValue: 800 });
    expect(r.counts).toBe(1);
    expect((await leak({ to: '2026-09-30' })).totals.unexplained).toBe(1);
  });

  it('"@month" means the first of this month', async () => {
    const m = await makeMaterial({ name: 'Tape', uom: 'MTR' });
    await receive(m.id, 100, 5);
    const thisMonth = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 8);
    const now = await makeCount({ countDate: day(`${thisMonth}15`) });
    await addLine(now.id, m.id, { system: 100, counted: 90, reason: 'MISSING' });
    await approveCount(now.id);
    const old = await makeCount({ countDate: day('2020-01-15') });
    await addLine(old.id, m.id, { system: 90, counted: 80 });
    await approveCount(old.id);
    expect((await leak({ from: '@month' })).rows[0]).toMatchObject({ timesCounted: 1, unexplainedCount: 0 });
    expect((await leak({ to: '2020-12-31' })).rows[0]).toMatchObject({ timesCounted: 1, unexplainedCount: 1 });
  });

  it('a count still with the owner, or sent back, is not part of it yet', async () => {
    const { copper } = await twoMonths();
    const pending = await makeCount({ countDate: day('2026-11-30') });
    await addLine(pending.id, copper.id, { system: 97, counted: 50, reason: 'MISSING' });
    await setCountStatus(pending.id, 'PENDING_APPROVAL');
    expect((await leak()).rows[0]).toMatchObject({ timesCounted: 2, varianceValue: 2400 });
  });

  it('narrows to named materials, and says what it could not find', async () => {
    await twoMonths();
    const r = await leak({ materialNames: ['bobbin type b', 'Unobtainium'] });
    expect(r.rows.map((x) => x.material)).toEqual(['Bobbin Type-B']);
    expect(r.notFound).toEqual(['Unobtainium']);
  });

  it('with no approved monthly count it says so, and with matching counts it says everything matched', async () => {
    const o = await owner();
    const none = await runTool(o, 'get_leak_report', {});
    expect(none).toMatchObject({ ok: true, data: { rows: [], counts: 0 } });
    const m = await makeMaterial({ name: 'Tape' });
    await receive(m.id, 10, 5);
    const c = await makeCount();
    await addLine(c.id, m.id, { system: 10, counted: 10 });
    await approveCount(c.id);
    const r = await leak();
    expect(r.rows).toEqual([]);
    expect(r.counts).toBe(1);
  });

  it('is the owner\'s: the storekeeper is told so and nothing is read', async () => {
    await twoMonths();
    const f = await fails(runTool(await storekeeper(), 'get_leak_report', {}));
    expect(f.code).toBe('FORBIDDEN_ROLE');
  });

  it('shows facts and numbers only: nothing in the answer names a person', async () => {
    await twoMonths();
    const text = JSON.stringify(await leak());
    expect(text).not.toMatch(/Test (OWNER|STOREKEEPER)/);
  });
});

/** Go-live is done: a monthly count can only start after the opening count was approved. */
async function goneLive() {
  const m = await makeMaterial({ name: 'Opening Filler' });
  const c = await makeCount({ isOpening: true, countDate: day('2026-08-01') });
  await addLine(c.id, m.id, { system: 0, counted: 0 });
  await approveCount(c.id);
}

describe('get_count_history (ACCEPTANCE 12.4, 12.5)', () => {
  it('shows every count of the material, newest first, with the system quantity, the reason and the date', async () => {
    await twoMonths();
    const s = await storekeeper();
    const r = await ok<{ rows: Record<string, unknown>[] }>(runTool(s, 'get_count_history', { materialNames: ['Bobbin Type-B'] }));
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ kind: 'Monthly count', systemQty: 612, countedQty: 612, difference: 0 });
    expect(r.rows[1]).toMatchObject({ systemQty: 652, countedQty: 612, difference: -40, reason: "Don't know" });
  });

  it('names who counted: the person who entered the line', async () => {
    await goneLive();
    const s = await storekeeper();
    await ok(save(s, 'create_material', material('Bobbin Type-B')));
    const bobbin = await prisma.material.findFirstOrThrow({ where: { name: 'Bobbin Type-B' } });
    await receive(bobbin.id, 652, 9);
    await ok(save(s, 'start_stock_count', { countDate: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) }));
    const line = await prisma.stockCountLine.findFirstOrThrow({ where: { materialId: bobbin.id } });
    await ok(save(s, 'submit_count_line', { stockCountLineId: line.id, countedQty: 612, reasonCode: 'UNEXPLAINED' }));
    const o = await owner();
    const r = await ok<{ rows: { by: string; statusText: string; difference: number }[] }>(runTool(o, 'get_count_history', { materialNames: ['bobbins type-b'] }));
    expect(r.rows[0]).toMatchObject({ by: s.name, difference: -40, statusText: 'Being counted' });
  });

  it('names who counted when the sheet saved the rows', async () => {
    await goneLive();
    const s = await storekeeper();
    await ok(save(s, 'create_material', material('Varnish', { uom: 'LTR' })));
    const varnish = await prisma.material.findFirstOrThrow({ where: { name: 'Varnish' } });
    await receive(varnish.id, 40, 340);
    await ok(save(s, 'start_stock_count', { countDate: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) }));
    const line = await prisma.stockCountLine.findFirstOrThrow({ where: { materialId: varnish.id } });
    await ok(save(s, 'save_count_sheet', { stockCountId: line.stockCountId, lines: [{ stockCountLineId: line.id, countedQty: 34 }] }));
    const r = await ok<{ rows: { by: string }[] }>(runTool(await owner(), 'get_count_history', { materialNames: ['Varnish'] }));
    expect(r.rows[0]?.by).toBe(s.name);
  });

  it('the opening count shows what was counted, with no difference', async () => {
    const m = await makeMaterial({ name: 'Paint', uom: 'LTR' });
    const c = await makeCount({ isOpening: true, countDate: day('2026-08-01') });
    await addLine(c.id, m.id, { system: 0, counted: 12, rate: 420 });
    await approveCount(c.id);
    const r = await ok<{ rows: { kind: string; difference: number | null; countedQty: number }[] }>(runTool(await owner(), 'get_count_history', { materialNames: ['Paint'] }));
    expect(r.rows[0]).toMatchObject({ kind: 'Opening count', difference: null, countedQty: 12 });
  });

  it('asks which material when none is named; says when it was never counted', async () => {
    const s = await storekeeper();
    expect((await fails(runTool(s, 'get_count_history', {}))).code).toBe('MATERIAL_REQUIRED');
    await makeMaterial({ name: 'Thinner', uom: 'LTR' });
    expect(await ok(runTool(s, 'get_count_history', { materialNames: ['Thinner'] }))).toMatchObject({ rows: [] });
  });
});

describe('get_job_cost_report (ACCEPTANCE 9.3)', () => {
  async function jobs() {
    const customer = await makeParty('customer', { name: 'Southern Railway' });
    const po = await prisma.customerPo.create({ data: { number: 'SRSW-OP-44', customerId: customer.id, poDate: new Date() } });
    const wire = await makeMaterial({ name: 'Wire', uom: 'KG' });
    await receive(wire.id, 1000, 800);
    const closed = await makeJob({ customerId: customer.id, customerPoId: po.id, quantity: 100, status: 'CLOSED', closedAt: day('2026-10-05'), materialCost: 4000, number: 'JOB-1' });
    const open = await makeJob({ customerId: customer.id, customerPoId: po.id, quantity: 200, status: 'MATERIAL_ISSUED', number: 'JOB-2' });
    const third = await makeJob({ customerId: customer.id, customerPoId: po.id, quantity: 150, number: 'JOB-3' });
    const other = await makeJob({ quantity: 10, status: 'CLOSED', closedAt: day('2026-09-01'), materialCost: 99, number: 'JOB-4' });
    await prisma.stockMovement.create({ data: { materialId: wire.id, type: 'ISSUE', direction: 'OUT', quantity: 5, rate: 800, jobId: open.id, movementDate: new Date() } });
    await prisma.stockMovement.create({ data: { materialId: wire.id, type: 'RETURN', direction: 'IN', quantity: 1, rate: 800, jobId: open.id, movementDate: new Date() } });
    return { customer, po, closed, open, third, other };
  }
  type Report = { rows: { job: string; materialCost: number; costPerPiece: number | null; statusText: string; customerPo: string | null }[]; total: number };

  it('is closed jobs by default, each with its cost and its cost per piece', async () => {
    await jobs();
    const r = await ok<Report>(runTool(await owner(), 'get_job_cost_report', {}));
    expect(r.rows.map((x) => x.job).sort()).toEqual(['JOB-1', 'JOB-4']);
    expect(r.rows.find((x) => x.job === 'JOB-1')).toMatchObject({ materialCost: 4000, costPerPiece: 40, statusText: 'Closed' });
  });

  it('a period is by the day the job closed', async () => {
    await jobs();
    const r = await ok<Report>(runTool(await owner(), 'get_job_cost_report', { from: '2026-10-01', to: '2026-10-31' }));
    expect(r.rows.map((x) => x.job)).toEqual(['JOB-1']);
  });

  it('every job under one customer PO, each costed separately, open ones as the cost so far (9.3)', async () => {
    const { po } = await jobs();
    const r = await ok<Report>(runTool(await owner(), 'get_job_cost_report', { customerPoId: po.id, includeOpen: true }));
    expect(r.rows.map((x) => x.job).sort()).toEqual(['JOB-1', 'JOB-2', 'JOB-3']);
    expect(r.rows.find((x) => x.job === 'JOB-2')).toMatchObject({ materialCost: 3200, costPerPiece: 16, statusText: 'Open, material issued', customerPo: 'SRSW-OP-44' });
    expect(r.rows.find((x) => x.job === 'JOB-3')).toMatchObject({ materialCost: 0, statusText: 'Open, nothing issued' });
    expect(r.total).toBe(7200);
  });

  it('a cancelled job is never in it, and the storekeeper cannot ask', async () => {
    const { third } = await jobs();
    await prisma.job.update({ where: { id: third.id }, data: { status: 'CANCELLED' } });
    const r = await ok<Report>(runTool(await owner(), 'get_job_cost_report', { includeOpen: true }));
    expect(r.rows.map((x) => x.job)).not.toContain('JOB-3');
    expect((await fails(runTool(await storekeeper(), 'get_job_cost_report', {}))).code).toBe('FORBIDDEN_ROLE');
  });
});

describe('estimate_job_cost (the what-if)', () => {
  async function openJobs() {
    const copper = await makeMaterial({ name: '22 SWG Copper Wire', uom: 'KG' });
    const tape = await makeMaterial({ name: 'Insulation Tape', uom: 'MTR' });
    await receive(copper.id, 500, 800);
    await receive(tape.id, 1000, 3);
    const a = await makeJob({ quantity: 100, number: 'JOB-A' });
    const b = await makeJob({ quantity: 50, number: 'JOB-B' });
    await prisma.jobBomLine.createMany({ data: [
      { jobId: a.id, materialId: copper.id, qtyPerPiece: 0.5, requiredQty: 50 }, { jobId: a.id, materialId: tape.id, qtyPerPiece: 2, requiredQty: 200 },
      { jobId: b.id, materialId: copper.id, qtyPerPiece: 1, requiredQty: 50 },
    ] });
    return { a, b };
  }
  type Est = { rows: { job: string; currentCost: number; estimatedCost: number; change: number; changePct: number | null; costPerPiece: number }[]; totals: { current: number; estimated: number }; noRate: string[]; notFound: string[] };

  it('prices what each open job needs at today\'s rates, then with copper at ₹900', async () => {
    await openJobs();
    const r = await ok<Est>(runTool(await owner(), 'estimate_job_cost', { materialNames: ['22 SWG Copper Wire'], newRate: 900 }));
    expect(r.rows.find((x) => x.job === 'JOB-A')).toMatchObject({ currentCost: 40_600, estimatedCost: 45_600, change: 5000, changePct: 12.32, costPerPiece: 456 });
    expect(r.rows.find((x) => x.job === 'JOB-B')).toMatchObject({ currentCost: 40_000, estimatedCost: 45_000, change: 5000 });
    expect(r.totals).toEqual({ current: 80_600, estimated: 90_600 });
  });

  it('saves nothing and changes no price', async () => {
    await openJobs();
    const before = { audit: await prisma.auditEvent.count(), bal: await prisma.stockBalance.findMany({ orderBy: { materialId: 'asc' } }), movements: await prisma.stockMovement.count() };
    await ok(runTool(await owner(), 'estimate_job_cost', { materialNames: ['22 SWG Copper Wire'], newRate: 1 }));
    expect(await prisma.stockMovement.count()).toBe(before.movements);
    expect(await prisma.stockBalance.findMany({ orderBy: { materialId: 'asc' } })).toEqual(before.bal);
  });

  it('with nothing changed, now and "if changed" are the same; a closed job is left out', async () => {
    const { a } = await openJobs();
    await prisma.job.update({ where: { id: a.id }, data: { status: 'CLOSED' } });
    const r = await ok<Est>(runTool(await owner(), 'estimate_job_cost', {}));
    expect(r.rows.map((x) => x.job)).toEqual(['JOB-B']);
    expect(r.rows[0]).toMatchObject({ currentCost: 40_000, estimatedCost: 40_000, change: 0 });
  });

  it('needs a rate when a material is named, refuses a rate of nothing, and says which material it could not find', async () => {
    await openJobs();
    const o = await owner();
    expect((await fails(runTool(o, 'estimate_job_cost', { materialNames: ['22 SWG Copper Wire'] }))).code).toBe('RATE_REQUIRED');
    expect(await fails(runTool(o, 'estimate_job_cost', { materialNames: ['22 SWG Copper Wire'], newRate: 0 }))).toMatchObject({ code: 'INVALID_INPUT' });
    const f = await fails(runTool(o, 'estimate_job_cost', { materialNames: ['Unobtainium'], newRate: 5 }));
    expect(f).toMatchObject({ code: 'NOT_FOUND' });
    expect(f.message).toContain('Unobtainium');
  });

  it('says when a material has no rate yet, and it is the owner\'s alone', async () => {
    const m = await makeMaterial({ name: 'New Stuff' });
    const j = await makeJob({ quantity: 10 });
    await prisma.jobBomLine.create({ data: { jobId: j.id, materialId: m.id, qtyPerPiece: 1, requiredQty: 10 } });
    expect((await ok<Est>(runTool(await owner(), 'estimate_job_cost', {}))).noRate).toEqual(['New Stuff']);
    expect((await fails(runTool(await storekeeper(), 'estimate_job_cost', {}))).code).toBe('FORBIDDEN_ROLE');
  });
});

describe('get_activity (ACCEPTANCE 13.10–13.12)', () => {
  it('lists who did what, newest first, and tags the ones that came through the assistant', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_material', material('Tape', { uom: 'MTR' }), 'AGENT'));
    await ok(save(s, 'create_material', material('Paint', { uom: 'LTR' }), 'LAUNCHER'));
    const r = await ok<{ rows: { who: string; what: string; source: string; document: string | null }[] }>(runTool(await owner(), 'get_activity', { from: '@today' }));
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ who: s.name, what: 'Create material', source: 'From a button' });
    expect(r.rows[1]).toMatchObject({ who: s.name, what: 'Create material', source: 'From the chat assistant' });
  });

  it('filters by person, by kind of action and by date', async () => {
    const s = await storekeeper();
    const o = await owner();
    await ok(save(s, 'create_material', material('Tape', { uom: 'MTR' })));
    await ok(save(o, 'create_party', { name: 'Sundaram Ferrites', role: 'SUPPLIER' }));
    const rows = async (input: object) => (await ok<{ rows: { who: string; what: string }[] }>(runTool(o, 'get_activity', input))).rows;
    expect((await rows({ userId: s.userId })).map((x) => x.what)).toEqual(['Create material']);
    expect((await rows({ tool: 'create_party' })).map((x) => x.who)).toEqual([o.name]);
    expect(await rows({ from: '@today-7d', to: '@today-1d' })).toEqual([]);
    expect((await fails(runTool(o, 'get_activity', { tool: 'drop table' }))).code).toBe('INVALID_INPUT');
  });

  it('every change to one job (13.12), and only the owner may ask (13.10)', async () => {
    const s = await storekeeper();
    const j = await makeJob({ number: 'JOB-31' });
    const other = await makeJob({ number: 'JOB-32' });
    await ok(save(s, 'cancel_job', { jobId: j.id, reason: 'Customer withdrew the order' }));
    const r = await ok<{ rows: { what: string; document: string | null; reason: string | null }[] }>(runTool(await owner(), 'get_activity', { jobId: j.id }));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ what: 'Cancel job', document: 'JOB-31', reason: 'Customer withdrew the order' });
    expect((await ok<{ rows: unknown[] }>(runTool(await owner(), 'get_activity', { jobId: other.id }))).rows).toEqual([]);
    expect((await fails(runTool(s, 'get_activity', {}))).code).toBe('FORBIDDEN_ROLE');
  });
});

describe('get_stock_value for named materials (ACCEPTANCE 13.1, 13.2)', () => {
  it('the total is across everything; naming a material gives just that one, quantity times average rate', async () => {
    const copper = await makeMaterial({ name: '22 SWG Copper Wire', uom: 'KG' });
    const tape = await makeMaterial({ name: 'Insulation Tape', uom: 'MTR' });
    await receive(copper.id, 142.6, 812);
    await receive(tape.id, 820, 3.1);
    const o = await owner();
    const all = await ok<{ total: number; rows: unknown[] }>(runTool(o, 'get_stock_value', {}));
    expect(all.rows).toHaveLength(2);
    expect(all.total).toBeCloseTo(142.6 * 812 + 820 * 3.1, 2);
    const one = await ok<{ total: number; rows: { material: string; value: number }[]; filtered: boolean }>(runTool(o, 'get_stock_value', { materialNames: ['copper wire 22 swg'] }));
    expect(one.rows.map((r) => r.material)).toEqual(['22 SWG Copper Wire']);
    expect(one.total).toBeCloseTo(142.6 * 812, 2);
    expect(one.filtered).toBe(true);
    expect((await ok<{ notFound: string[] }>(runTool(o, 'get_stock_value', { materialNames: ['Unobtainium'] }))).notFound).toEqual(['Unobtainium']);
  });
});
