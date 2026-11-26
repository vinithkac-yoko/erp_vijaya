import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runTool } from '@/server/tools';
import { balance, prisma, receive, resetDb, makeUser } from './helpers/db';
import { fails, material, ok, owner, save, seedSettings, storekeeper } from './helpers/tools';

beforeEach(async () => { await resetDb(); await seedSettings(); });
afterAll(() => prisma.$disconnect());

type S = Awaited<ReturnType<typeof storekeeper>>;
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** ACCEPTANCE §2: the nine materials and the made-up rates, to be used exactly so the totals can be checked. */
const NINE = [
  { name: '22 SWG Copper Wire', uom: 'KG', qty: 145, rate: 812, invoice: 'CCW/2627/0388' },
  { name: 'Ferrite Core E-30', uom: 'NOS', qty: 18, rate: 65, min: 50 },
  { name: 'Bobbin Type-B', uom: 'NOS', qty: 640, rate: 9 },
  { name: 'Insulation Tape', uom: 'MTR', qty: 820, rate: 3.1 },
  { name: 'Varnish', uom: 'LTR', qty: 38, rate: 340 },
  { name: 'Paint', uom: 'LTR', qty: 12, rate: 420 },
  { name: 'Thinner', uom: 'LTR', qty: 20, rate: 150 },
  { name: 'Stickers', uom: 'NOS', qty: 3000, rate: 0.5 },
  { name: 'Copper Scrap', uom: 'KG', qty: 0, rate: 0 },
] as const;

async function setup(s: S) {
  for (const m of NINE) {
    await ok(save(s, 'create_material', material(m.name, { uom: m.uom, ...('min' in m ? { stockType: 'STANDING', minimumLevel: m.min } : {}), ...(m.name === 'Copper Scrap' ? { isScrap: true } : {}) })));
  }
}
type Row = Record<string, unknown> & { id: string; material: string };
const lines = async (s: S, input: object = {}) => (await ok<{ rows: Row[]; counted: number; total: number; totalValue: number | null; count: { id: string; kind: string } }>(runTool(s, 'list_count_lines', input)));
const lineOf = async (s: S, name: string) => (await lines(s)).rows.find((r) => r.material === name)!;
const startOpening = (s: S) => save(s, 'start_stock_count', { countDate: today(), isOpening: true });
async function enter(s: S, name: string, e: Record<string, unknown>) {
  const l = await lineOf(s, name);
  return save(s, 'submit_count_line', { stockCountLineId: l.id, ...e });
}
/** The count sheet's own save: one or more rows. */
async function sheet(s: S, edits: { name: string; [k: string]: unknown }[]) {
  const l = await lines(s);
  return save(s, 'save_count_sheet', { stockCountId: l.count.id, lines: edits.map(({ name, ...rest }) => ({ stockCountLineId: l.rows.find((r) => r.material === name)!.id, ...rest })) });
}
async function fillAll(s: S, skip: string[] = []) {
  for (const m of NINE) {
    if (skip.includes(m.name)) continue;
    await ok(enter(s, m.name, { countedQty: m.qty, ...(m.qty > 0 ? { unitRate: m.rate } : {}), ...('invoice' in m ? { sourceInvoiceNo: m.invoice } : {}) }));
  }
}

describe('the opening count (ACCEPTANCE §2)', () => {
  it('starts with every material at zero, no System or Difference column, and says what to enter (2.1, 2.3)', async () => {
    const s = await storekeeper(); await setup(s);
    const started = await ok<{ number: string; materials: number }>(startOpening(s));
    expect(started).toMatchObject({ number: expect.stringMatching(/^CNT-\d{4}-0001$/), materials: 9 });
    const l = await lines(s);
    expect(l.rows).toHaveLength(9);
    expect(l.rows[0]).toMatchObject({ systemQty: null, difference: null, countedQty: null, missing: 'quantity and rate' });
    expect(l.count.kind).toBe('Opening count');
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'start_stock_count' } });
    expect(audit.afterJson).toMatchObject({ materials: 9, isOpening: true });
  });

  it('a second one is refused while one is open, naming it (2.2)', async () => {
    const s = await storekeeper(); await setup(s); await ok(startOpening(s));
    const f = await fails(startOpening(s));
    expect(f.code).toBe('OPENING_IN_PROGRESS');
    expect(f.message).toContain('already started');
    expect(await prisma.stockCount.count()).toBe(1);
  });

  it('a normal count cannot come before the opening count is approved', async () => {
    const s = await storekeeper(); await setup(s);
    expect((await fails(save(s, 'start_stock_count', { countDate: today() }))).code).toBe('OPENING_NOT_DONE');
  });

  it('quantity first, rate later, no reason ever, quantity untouched by the rate (2.4, 2.5, 2.18)', async () => {
    const s = await storekeeper(); await setup(s); await ok(startOpening(s));
    await ok(enter(s, '22 SWG Copper Wire', { countedQty: 142.6 }));
    let w = await lineOf(s, '22 SWG Copper Wire');
    expect(w).toMatchObject({ countedQty: 142.6, unitRate: null, missing: 'rate', reason: null });
    await ok(enter(s, '22 SWG Copper Wire', { unitRate: 812, sourceInvoiceNo: 'CCW/2627/0388' }));
    w = await lineOf(s, '22 SWG Copper Wire');
    expect(w).toMatchObject({ countedQty: 142.6, unitRate: 812, sourceInvoiceNo: 'CCW/2627/0388', missing: null });
    await ok(enter(s, '22 SWG Copper Wire', { countedQty: 145 })); // "I missed a spool"
    expect(await lineOf(s, '22 SWG Copper Wire')).toMatchObject({ countedQty: 145, unitRate: 812, reason: null });
    expect(await prisma.stockCountLine.count({ where: { reasonCode: { not: null } } })).toBe(0);
  });

  it('a rate of zero is refused; the invoice number is optional; a reason sent by mistake is ignored (2.6, 2.10)', async () => {
    const s = await storekeeper(); await setup(s); await ok(startOpening(s));
    const z = await fails(enter(s, 'Insulation Tape', { countedQty: 820, unitRate: 0 }));
    expect(z).toMatchObject({ code: 'INVALID_RATE', field: 'unitRate' });
    await ok(enter(s, 'Ferrite Core E-30', { countedQty: 18, unitRate: 65, reasonCode: 'MISSING' }));
    expect(await lineOf(s, 'Ferrite Core E-30')).toMatchObject({ missing: null, sourceInvoiceNo: null, reason: null });
  });

  it('zero stock needs no rate, and pieces are whole (2.11, 2.12)', async () => {
    const s = await storekeeper(); await setup(s); await ok(startOpening(s));
    await ok(enter(s, 'Copper Scrap', { countedQty: 0 }));
    expect((await lineOf(s, 'Copper Scrap')).missing).toBeNull();
    const f = await fails(enter(s, 'Stickers', { countedQty: 2999.5 }));
    expect(f.code).toBe('INVALID_QUANTITY');
  });

  it('"what\'s left to finish?" lists only what is unfinished, with what is missing (2.13)', async () => {
    const s = await storekeeper(); await setup(s); await ok(startOpening(s));
    await fillAll(s, ['Paint', 'Thinner']);
    await ok(enter(s, 'Insulation Tape', { unitRate: 3.1 })); // already has the rate; remove it again via a fresh line below
    const left = await lines(s, { onlyUnfinished: true });
    expect(left.rows.map((r) => [r.material, r.missing])).toEqual([['Paint', 'quantity and rate'], ['Thinner', 'quantity and rate']]);
  });

  it('submit is refused naming what is missing (2.14)', async () => {
    const s = await storekeeper(); await setup(s); await ok(startOpening(s));
    await fillAll(s, ['Paint', 'Thinner', 'Insulation Tape']);
    await ok(enter(s, 'Insulation Tape', { countedQty: 820 })); // quantity, no rate
    const f = await fails(save(s, 'submit_stock_count', {}));
    expect(f.code).toBe('COUNT_INCOMPLETE');
    expect(f.message).toBe('Not counted yet: Paint, Thinner. No rate yet: Insulation Tape.');
    expect((await prisma.stockCount.findFirstOrThrow()).status).toBe('DRAFT');
  });

  it('the whole story: send, locked, sent back with a note, fixed, approved at ₹1,49,672 then ₹1,49,780 (2.15–2.41)', async () => {
    const sk = await storekeeper(); const ow = await owner(); await setup(sk);
    await ok(startOpening(sk));
    // over several days, in several goes; the sheet saves rows as they are typed
    await ok(sheet(sk, [{ name: '22 SWG Copper Wire', countedQty: 145, unitRate: 812, sourceInvoiceNo: 'CCW/2627/0388' }, { name: 'Ferrite Core E-30', countedQty: 18, unitRate: 65 }]));
    await ok(sheet(sk, [{ name: 'Bobbin Type-B', countedQty: 640, unitRate: 9 }, { name: 'Insulation Tape', countedQty: 820 }, { name: 'Varnish', countedQty: 38, unitRate: 340 }, { name: 'Stickers', countedQty: 3000 }]));
    await ok(sheet(sk, [{ name: 'Paint', countedQty: 12, unitRate: 420 }, { name: 'Thinner', countedQty: 20, unitRate: 150 }, { name: 'Copper Scrap', countedQty: 0 }]));
    await ok(sheet(sk, [{ name: 'Insulation Tape', unitRate: 3.1 }, { name: 'Stickers', unitRate: 0.5 }]));
    expect((await lineOf(sk, '22 SWG Copper Wire')).countedQty).toBe(145);

    const sent = await ok<{ number: string; summary: string }>(save(sk, 'submit_stock_count', {}));
    expect(sent.summary).toBe('8 materials with stock, total value ₹1,49,672.');
    expect(await balance((await prisma.material.findFirstOrThrow({ where: { name: '22 SWG Copper Wire' } })).id)).toMatchObject({ qty: 0 }); // 2.21: still 0 kg

    // locked while with the owner (2.25)
    const locked = await fails(enter(sk, 'Thinner', { countedQty: 25 }));
    expect(locked.code).toBe('COUNT_LOCKED');
    expect(locked.message).toContain('with the owner');
    expect((await fails(sheet(sk, [{ name: 'Thinner', countedQty: 25 }]))).code).toBe('COUNT_LOCKED');

    // the storekeeper cannot approve, or send back, whatever he says (2.23, 2.24)
    for (const t of ['approve_stock_count', 'reject_stock_count']) {
      const r = await runTool(sk, t, {}, {});
      expect(r).toMatchObject({ ok: false });
    }
    expect((await fails(save(sk, 'approve_stock_count', {}))).code).toBe('FORBIDDEN_ROLE');

    // the owner sees the count and the total (2.26, 2.27, 2.28)
    const waiting = await ok<{ counts: { summary: string; amount: number }[] }>(runTool(ow, 'list_pending_approvals', {}));
    expect(waiting.counts[0]).toMatchObject({ amount: 149672, summary: '8 materials with stock, total value ₹1,49,672.' });
    const seen = await lines(ow);
    expect(seen.rows.find((r) => r.material === '22 SWG Copper Wire')).toMatchObject({ unitRate: 812, sourceInvoiceNo: 'CCW/2627/0388', value: 117740 });

    // sent back with a note (2.29, 2.30)
    await ok(save(ow, 'reject_stock_count', { rejectionNote: 'Recount the bobbins, 640 looks low' }));
    expect((await prisma.stockCount.findFirstOrThrow()).status).toBe('REJECTED');
    const told = await prisma.notification.findMany({ where: { userId: sk.userId } });
    expect(told).toMatchObject([{ type: 'RECOUNT_REQUIRED', body: expect.stringContaining('Recount the bobbins') }]);
    expect(await prisma.notification.count({ where: { userId: ow.userId, type: 'RECOUNT_REQUIRED' } })).toBe(0);
    expect(await prisma.stockMovement.count()).toBe(0);

    // the same count is fixed and sent again (2.31, 2.32)
    await ok(enter(sk, 'Bobbin Type-B', { countedQty: 652 }));
    expect(await prisma.stockCount.count()).toBe(1);
    const again = await ok<{ summary: string; resent: boolean }>(save(sk, 'submit_stock_count', {}));
    expect(again).toMatchObject({ resent: true, summary: '8 materials with stock, total value ₹1,49,780.' });

    // approved (2.33–2.41)
    const approved = await ok<{ posted: number; totalValue: number }>(save(ow, 'approve_stock_count', {}));
    expect(approved).toMatchObject({ posted: 8, totalValue: 149780 });
    const rows = await prisma.$queryRawUnsafe<{ type: string; n: bigint }[]>(`select type::text, count(*) n from stock_movements group by type`);
    expect(rows.map((r) => [r.type, Number(r.n)])).toEqual([['OPENING', 8]]);
    expect(await prisma.$queryRawUnsafe(`select * from v_material_leak`)).toHaveLength(0);
    const worth = await ok<{ total: number; rows: { material: string; value: number }[] }>(runTool(ow, 'get_stock_value', {}));
    expect(worth.total).toBe(149780);
    expect(worth.rows.find((r) => r.material === '22 SWG Copper Wire')?.value).toBe(117740);
    const stock = await ok<{ rows: { material: string; quantity: number }[] }>(runTool(sk, 'get_material_balance', {}));
    expect(Object.fromEntries(stock.rows.map((r) => [r.material, r.quantity]))).toEqual({
      '22 SWG Copper Wire': 145, 'Ferrite Core E-30': 18, 'Bobbin Type-B': 652, 'Insulation Tape': 820, Varnish: 38, Paint: 12, Thinner: 20, Stickers: 3000, 'Copper Scrap': 0,
    });
    const alerts = await ok<{ rows: { material: string; onHand: number; minimumLevel: number }[] }>(runTool(ow, 'list_reorder_alerts', {}));
    expect(alerts.rows).toEqual([expect.objectContaining({ material: 'Ferrite Core E-30', onHand: 18, minimumLevel: 50 })]);
    expect((await prisma.notification.findMany({ where: { userId: sk.userId, type: 'COUNT_APPROVED' } })).length).toBe(1);

    // once, ever; and nobody just sets the stock (2.40, 2.41)
    expect((await fails(startOpening(sk))).code).toBe('OPENING_ALREADY_DONE');
    const wire = await prisma.stockCountLine.findFirstOrThrow({ where: { material: { name: '22 SWG Copper Wire' } } });
    expect((await fails(save(sk, 'submit_count_line', { stockCountLineId: wire.id, countedQty: 150 }))).code).toBe('COUNT_LOCKED'); // "change the wire stock to 150"
    expect(Number((await prisma.stockCountLine.findUniqueOrThrow({ where: { id: wire.id } })).countedQty)).toBe(145);
    expect((await prisma.stockCount.findFirstOrThrow()).status).toBe('APPROVED');
    // an approved count is final even for the owner
    expect((await fails(save(ow, 'approve_stock_count', {}))).code).toBe('NOT_FOUND'); // nothing is waiting
  });

  it('refuses to start after stock has been recorded, and to approve if stock arrived meanwhile', async () => {
    const s = await storekeeper(); const ow = await owner(); await setup(s);
    const mat = await prisma.material.findFirstOrThrow({ where: { name: 'Varnish' } });
    await receive(mat.id, 5, 100);
    expect((await fails(startOpening(s))).code).toBe('OPENING_NOT_FIRST');
    await prisma.$transaction([prisma.$executeRawUnsafe(`SET LOCAL vijaya.allow_reset = 'on'`), prisma.$executeRawUnsafe(`TRUNCATE stock_movements CASCADE`)]);
    await ok(startOpening(s)); await fillAll(s);
    await ok(save(s, 'submit_stock_count', {}));
    await receive(mat.id, 5, 100);
    expect((await fails(save(ow, 'approve_stock_count', {}))).code).toBe('OPENING_NOT_FIRST');
    expect((await prisma.stockCount.findFirstOrThrow()).status).toBe('PENDING_APPROVAL');
  });

  it('a material added while the opening count is open joins it', async () => {
    const s = await storekeeper(); await setup(s); await ok(startOpening(s));
    await ok(save(s, 'create_material', material('Cotton Tape', { uom: 'MTR' })));
    const l = await lines(s);
    expect(l.total).toBe(10);
    expect(l.rows.find((r) => r.material === 'Cotton Tape')).toMatchObject({ countedQty: null });
  });

  it('only one count is open at a time, and a count can be opened from "Count stock" while one is in progress', async () => {
    const s = await storekeeper(); await setup(s); await ok(startOpening(s));
    expect((await prisma.stockCount.count({ where: { status: { in: ['DRAFT', 'REJECTED', 'PENDING_APPROVAL'] } } }))).toBe(1);
    const open = await ok<{ rows: { number: string; counted: number; total: number; type: string; status: string }[] }>(runTool(s, 'list_counts', {}));
    expect(open.rows[0]).toMatchObject({ type: 'Opening count', status: 'DRAFT', counted: 0, total: 9 });
  });
});

describe('a normal count', () => {
  /** Go-live done: copper 100 kg @ ₹800, 50 pieces of cores @ ₹65. */
  async function live() {
    const sk = await storekeeper(); const ow = await owner();
    await ok(save(sk, 'create_material', material('Copper Wire', { uom: 'KG' })));
    await ok(save(sk, 'create_material', material('Ferrite Core', { stockType: 'STANDING', minimumLevel: 10 })));
    await ok(startOpening(sk));
    await ok(sheet(sk, [{ name: 'Copper Wire', countedQty: 100, unitRate: 800 }, { name: 'Ferrite Core', countedQty: 50, unitRate: 65 }]));
    await ok(save(sk, 'submit_stock_count', {}));
    await ok(save(ow, 'approve_stock_count', {}));
    return { sk, ow };
  }

  it('freezes the system quantity, shows it to both people, and takes no rate', async () => {
    const { sk } = await live();
    await ok(save(sk, 'start_stock_count', { countDate: today() }));
    const l = await lines(sk);
    expect(l.count.kind).toBe('Stock count');
    expect(l.rows.find((r) => r.material === 'Copper Wire')).toMatchObject({ systemQty: 100, countedQty: null });
    expect((await fails(enter(sk, 'Copper Wire', { countedQty: 98, unitRate: 800 }))).code).toBe('RATE_NOT_ALLOWED');
    expect((await fails(save(sk, 'start_stock_count', { countDate: today() }))).code).toBe('COUNT_IN_PROGRESS');
  });

  it('a difference with no reason is stored as "don\'t know" and never asked again; a recount to equal clears it', async () => {
    const { sk } = await live();
    await ok(save(sk, 'start_stock_count', { countDate: today() }));
    await ok(enter(sk, 'Copper Wire', { countedQty: 97.5 }));
    expect(await lineOf(sk, 'Copper Wire')).toMatchObject({ difference: -2.5, reason: 'UNEXPLAINED' });
    await ok(enter(sk, 'Copper Wire', { reasonCode: 'SPILLAGE' }));
    expect((await lineOf(sk, 'Copper Wire')).reason).toBe('SPILLAGE');
    await ok(enter(sk, 'Copper Wire', { countedQty: 100 }));
    expect(await lineOf(sk, 'Copper Wire')).toMatchObject({ difference: 0, reason: null });
  });

  it('is approved with one adjustment per difference, at the current average rate, and shows in the leak view', async () => {
    const { sk, ow } = await live();
    await ok(save(sk, 'start_stock_count', { countDate: today() }));
    await ok(sheet(sk, [{ name: 'Copper Wire', countedQty: 97.5, reasonCode: 'SPILLAGE' }, { name: 'Ferrite Core', countedQty: 50 }]));
    const sent = await ok<{ summary: string }>(save(sk, 'submit_stock_count', {}));
    expect(sent.summary).toBe('1 material differs: ₹2,000 short.');
    const owners = await prisma.notification.findFirstOrThrow({ where: { userId: ow.userId, type: 'COUNT_PENDING_APPROVAL', body: { contains: 'differs' } } });
    expect(owners.title).toBe('Stock count waiting');
    const review = await ok<{ info?: string[] }>(runTool(ow, 'list_pending_approvals', {}));
    expect(review).toBeTruthy();
    await ok(save(ow, 'approve_stock_count', {}));
    const adj = await prisma.stockMovement.findMany({ where: { type: 'COUNT_ADJUSTMENT' } });
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ direction: 'OUT', reasonCode: 'SPILLAGE' });
    expect(Number(adj[0]?.quantity)).toBe(2.5);
    expect(Number(adj[0]?.rate)).toBe(800);
    expect(Number(adj[0]?.value)).toBe(2000);
    const mat = await prisma.material.findFirstOrThrow({ where: { name: 'Copper Wire' } });
    expect(await balance(mat.id)).toMatchObject({ qty: 97.5, rate: 800 });
    const leak = await prisma.$queryRawUnsafe<{ material_name: string; times_mismatched: bigint }[]>(`select * from v_material_leak`);
    expect(leak.map((r) => [r.material_name, Number(r.times_mismatched)])).toEqual([['Copper Wire', 1], ['Ferrite Core', 0]]);
  });

  it('the owner can start and enter a count too, as the back-up storekeeper', async () => {
    const { ow } = await live();
    await ok(save(ow, 'start_stock_count', { countDate: today() }));
    await ok(enter(ow, 'Copper Wire', { countedQty: 100 }));
    expect((await lineOf(ow, 'Copper Wire')).countedQty).toBe(100);
  });

  it('the monthly story: sent to the owner, sent back with a note, no stock moved, recounted in the same count, sent again, approved (11.10–11.16)', async () => {
    const { sk, ow } = await live();
    const mat = await prisma.material.findFirstOrThrow({ where: { name: 'Copper Wire' } });
    await ok(save(sk, 'start_stock_count', { countDate: today() }));
    await ok(sheet(sk, [{ name: 'Copper Wire', countedQty: 92, reasonCode: 'MISSING' }, { name: 'Ferrite Core', countedQty: 50 }]));
    const started = await prisma.stockCount.findFirstOrThrow({ where: { isOpening: false } });
    await ok(save(sk, 'submit_stock_count', {}));
    await ok(save(ow, 'reject_stock_count', { rejectionNote: 'Please recount the copper' }));
    expect(await prisma.stockCount.findUniqueOrThrow({ where: { id: started.id } })).toMatchObject({ status: 'REJECTED', rejectionNote: 'Please recount the copper' });
    expect(await prisma.stockMovement.count({ where: { type: 'COUNT_ADJUSTMENT' } })).toBe(0);
    expect(await balance(mat.id)).toMatchObject({ qty: 100 });
    expect(await prisma.notification.findFirstOrThrow({ where: { userId: sk.userId, type: 'RECOUNT_REQUIRED' } })).toMatchObject({ body: expect.stringContaining('recount the copper') });
    // the same count is recounted, not a new one
    await ok(enter(sk, 'Copper Wire', { countedQty: 95 }));
    expect(await lineOf(sk, 'Copper Wire')).toMatchObject({ systemQty: 100, countedQty: 95, difference: -5, reason: 'MISSING' });
    expect(await prisma.stockCount.count({ where: { isOpening: false } })).toBe(1);
    await ok(save(sk, 'submit_stock_count', {}));
    expect(await prisma.notification.count({ where: { userId: ow.userId, type: 'COUNT_PENDING_APPROVAL', title: 'Stock count sent again' } })).toBe(1);
    await ok(save(ow, 'approve_stock_count', {}));
    expect(await balance(mat.id)).toMatchObject({ qty: 95, rate: 800 });
    expect(await prisma.notification.findFirstOrThrow({ where: { userId: sk.userId, type: 'COUNT_APPROVED' } })).toBeTruthy();
  });

  it('a count that matches asks for no reason and records none (11.7)', async () => {
    const { sk } = await live();
    await ok(save(sk, 'start_stock_count', { countDate: today() }));
    await ok(enter(sk, 'Ferrite Core', { countedQty: 50 }));
    expect(await lineOf(sk, 'Ferrite Core')).toMatchObject({ difference: 0, reason: null });
    await ok(enter(sk, 'Copper Wire', { countedQty: 100 }));
    await ok(save(sk, 'submit_stock_count', {}));
    expect(await prisma.stockCountLine.count({ where: { reasonCode: { not: null } } })).toBe(0);
  });

  it('the System column stays what it was when the count started, even if stock moves meanwhile (11.1, 11.8)', async () => {
    const { sk } = await live();
    const mat = await prisma.material.findFirstOrThrow({ where: { name: 'Copper Wire' } });
    await ok(save(sk, 'start_stock_count', { countDate: today() }));
    await receive(mat.id, 10, 800);
    expect(await balance(mat.id)).toMatchObject({ qty: 110 });
    expect(await lineOf(sk, 'Copper Wire')).toMatchObject({ systemQty: 100 });
    // there is no way to type a System quantity: a value sent for it is ignored, the frozen one stays
    await ok(enter(sk, 'Copper Wire', { countedQty: 100, systemQty: 110 }));
    expect(await lineOf(sk, 'Copper Wire')).toMatchObject({ systemQty: 100, countedQty: 100, difference: 0 });
  });

  it('an approved count cannot be changed by anyone; stock is only ever corrected by the next count (11.17)', async () => {
    const { sk, ow } = await live();
    await ok(save(sk, 'start_stock_count', { countDate: today() }));
    await ok(sheet(sk, [{ name: 'Copper Wire', countedQty: 97, reasonCode: 'SPILLAGE' }, { name: 'Ferrite Core', countedQty: 50 }]));
    const line = await lineOf(sk, 'Copper Wire');
    await ok(save(sk, 'submit_stock_count', {}));
    expect((await fails(enter(sk, 'Copper Wire', { countedQty: 100 }))).code).toBe('COUNT_LOCKED');
    await ok(save(ow, 'approve_stock_count', {}));
    for (const who of [sk, ow]) expect((await fails(save(who, 'submit_count_line', { stockCountLineId: line.id, countedQty: 100 }))).code).toBe('COUNT_LOCKED');
    expect((await fails(save(ow, 'save_count_sheet', { stockCountId: line.stockCountId ?? (await prisma.stockCount.findFirstOrThrow({ where: { isOpening: false } })).id, lines: [{ stockCountLineId: line.id, countedQty: 100 }] }))).code).toBe('COUNT_LOCKED');
  });

  it('a date in the future, or one that is not a date, is refused', async () => {
    const { sk } = await live();
    expect((await fails(save(sk, 'start_stock_count', { countDate: '2099-01-01' }))).code).toBe('INVALID_DATE');
    expect((await fails(save(sk, 'start_stock_count', { countDate: '2026-02-31' }))).code).toBe('INVALID_INPUT');
  });
});

describe('forms open with what the tool knows', () => {
  it('the start form is ticked as the opening count while go-live is not done, and carries today\'s date', async () => {
    const { pendingActions } = await import('@/server/tools');
    const s = await storekeeper(); await setup(s);
    const opened = await pendingActions.create(s, { tool: 'start_stock_count', origin: 'LAUNCHER' });
    if (!opened.ok) throw new Error('form did not open');
    const card = await pendingActions.formCard(s, opened.data);
    expect(card.values).toMatchObject({ isOpening: true, countDate: today() });
    expect(card.info?.[0]).toContain('opening count has not been done yet');
  });

  it('the approval form says what the owner is approving, with the biggest values, and carries the count', async () => {
    const { pendingActions } = await import('@/server/tools');
    const sk = await storekeeper(); const ow = await owner(); await setup(sk); await ok(startOpening(sk)); await fillAll(sk);
    await ok(save(sk, 'submit_stock_count', {}));
    const opened = await pendingActions.create(ow, { tool: 'approve_stock_count', origin: 'LAUNCHER' });
    if (!opened.ok) throw new Error('form did not open');
    const card = await pendingActions.formCard(ow, opened.data);
    expect(card.info).toEqual(expect.arrayContaining(['8 materials with stock, total value ₹1,49,672.', 'Biggest values:']));
    expect(card.info?.join('\n')).toContain('22 SWG Copper Wire: 145 kg at ₹812 = ₹1,17,740');
    expect(typeof card.values.stockCountId).toBe('string');
    expect(card.form.alt).toEqual({ tool: 'reject_stock_count', label: 'Send back' });
    void makeUser;
  });
});
