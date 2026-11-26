import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addLine, approveCount, balance, expectIntegrity, expectPlain, failure, giveBack, issue, makeCount, makeJob, makeMaterial, makeParty,
  makeUser, move, prisma, receive, resetDb, setCountStatus, uid,
} from './helpers/db';

beforeEach(() => resetDb());
afterEach(expectIntegrity); // every test ends with the ledger agreeing with the balances
afterAll(() => prisma.$disconnect());

describe('weighted average (BUSINESS_FLOW §14)', () => {
  it('800 → 850 → 850 → 850 → 880', async () => {
    const m = await makeMaterial();
    const job = await makeJob();

    await receive(m.id, 100, 800);
    expect(await balance(m.id)).toEqual({ qty: 100, rate: 800, value: 80000 });

    await receive(m.id, 100, 900);
    expect(await balance(m.id)).toEqual({ qty: 200, rate: 850, value: 170000 });

    const out = await issue(m.id, job.id, 50, /* the caller's rate is ignored: */ 1);
    expect(Number(out.rate)).toBe(850);
    expect(Number(out.value)).toBe(42500);
    expect(await balance(m.id)).toEqual({ qty: 150, rate: 850, value: 127500 });

    const back = await giveBack(m.id, job.id, 10, 5);
    expect(Number(back.rate)).toBe(850);
    expect(await balance(m.id)).toEqual({ qty: 160, rate: 850, value: 136000 });

    const last = await receive(m.id, 40, 1000);
    expect(await balance(m.id)).toEqual({ qty: 200, rate: 880, value: 176000 });
    // the running balance is stamped on the ledger row itself
    expect([Number(last.balanceQtyAfter), Number(last.balanceRateAfter), Number(last.balanceValueAfter)]).toEqual([200, 880, 176000]);
  });

  it('every material gets a balance row at birth, at zero', async () => {
    const m = await makeMaterial();
    expect(await balance(m.id)).toEqual({ qty: 0, rate: 0, value: 0 });
  });

  it('negative stock is allowed, not blocked', async () => {
    const m = await makeMaterial();
    const job = await makeJob();
    await receive(m.id, 3, 100);
    await issue(m.id, job.id, 5);
    expect((await balance(m.id)).qty).toBe(-2);
  });

  it('a receipt after a negative balance is averaged at what came in, not against a negative value', async () => {
    const m = await makeMaterial();
    const job = await makeJob();
    await issue(m.id, job.id, 5); // given out before the first receipt was written down
    expect(await balance(m.id)).toEqual({ qty: -5, rate: 0, value: 0 });
    await receive(m.id, 10, 100);
    expect(await balance(m.id)).toEqual({ qty: 5, rate: 100, value: 500 });
  });

  it('a receipt that still leaves stock negative keeps the old average', async () => {
    const m = await makeMaterial();
    const job = await makeJob();
    await receive(m.id, 10, 200);
    await issue(m.id, job.id, 15); // −5 at 200
    await receive(m.id, 2, 500);   // still −3
    expect((await balance(m.id)).rate).toBe(200);
  });

  it('the rate on a COUNT_ADJUSTMENT is the current average, whatever the caller passes', async () => {
    const m = await makeMaterial();
    await receive(m.id, 100, 800);
    const open = await makeCount({ isOpening: false });
    const line = await addLine(open.id, m.id, { system: 100, counted: 90, reason: 'MISSING' });
    await approveCount(open.id);
    const adj = await move({ materialId: m.id, type: 'COUNT_ADJUSTMENT', direction: 'OUT', quantity: 10, rate: 1, stockCountLineId: line.id });
    expect(Number(adj.rate)).toBe(800);
    expect(await balance(m.id)).toEqual({ qty: 90, rate: 800, value: 72000 });
  });
});

describe('the ledger is append-only', () => {
  async function oneMovement() {
    const m = await makeMaterial();
    const row = await receive(m.id, 10, 100);
    return { m, row };
  }

  it('UPDATE and DELETE on a movement are refused, in plain words', async () => {
    const { row } = await oneMovement();
    for (const attempt of [
      prisma.stockMovement.update({ where: { id: row.id }, data: { notes: 'edited' } }),
      prisma.stockMovement.delete({ where: { id: row.id } }),
      prisma.$executeRawUnsafe(`UPDATE stock_movements SET quantity = 999`),
      prisma.$executeRawUnsafe(`DELETE FROM stock_movements`),
    ]) {
      const f = await failure(attempt);
      expect(f.code).toBe('LEDGER_APPEND_ONLY');
      expectPlain(f);
    }
    expect(Number((await prisma.stockMovement.findUniqueOrThrow({ where: { id: row.id } })).quantity)).toBe(10);
  });

  it('audit events and artifact versions cannot be edited or deleted either', async () => {
    const user = await makeUser();
    const ev = await prisma.auditEvent.create({ data: { entityType: 'X', entityId: '1', action: 'CREATE', actorType: 'HUMAN', actorId: user.id } });
    expect((await failure(prisma.auditEvent.update({ where: { id: ev.id }, data: { reason: 'changed' } }))).code).toBe('LEDGER_APPEND_ONLY');
    expect((await failure(prisma.auditEvent.delete({ where: { id: ev.id } }))).code).toBe('LEDGER_APPEND_ONLY');

    const art = await prisma.artifact.create({ data: { ownerId: user.id, title: 'T', kind: 'DOCUMENT' } });
    const v = await prisma.artifactVersion.create({ data: { artifactId: art.id, n: 1, source: 'a', request: 'r', madeBy: 'AGENT' } });
    expect((await failure(prisma.artifactVersion.update({ where: { id: v.id }, data: { source: 'b' } }))).code).toBe('LEDGER_APPEND_ONLY');
    expect((await failure(prisma.artifactVersion.delete({ where: { id: v.id } }))).code).toBe('LEDGER_APPEND_ONLY');
  });

  it('TRUNCATE is refused on all three, unless the demo reset says so inside its own transaction', async () => {
    await oneMovement();
    for (const table of ['stock_movements', 'audit_events', 'artifact_versions']) {
      const f = await failure(prisma.$executeRawUnsafe(`TRUNCATE ${table} CASCADE`));
      expect(f.code).toBe('LEDGER_APPEND_ONLY');
    }
    expect(await prisma.stockMovement.count()).toBe(1);

    // the one allowed way: SET LOCAL in a transaction
    await prisma.$transaction([prisma.$executeRawUnsafe(`SET LOCAL vijaya.allow_reset = 'on'`), prisma.$executeRawUnsafe(`TRUNCATE stock_movements CASCADE`)]);
    expect(await prisma.stockMovement.count()).toBe(0);

    // …and it does not leak out of that transaction
    const f = await failure(prisma.$executeRawUnsafe(`TRUNCATE stock_movements CASCADE`));
    expect(f.code).toBe('LEDGER_APPEND_ONLY');

    // A real reset empties everything together (a ledger with no balances behind it would fail the integrity check).
    await resetDb();
  });
});

describe('every CHECK, in plain words', () => {
  it('movement quantities must be more than zero; rates cannot be negative', async () => {
    const m = await makeMaterial();
    for (const quantity of [0, -5]) {
      const f = await failure(move({ materialId: m.id, type: 'SCRAP_IN', direction: 'IN', quantity, rate: 0 }));
      expect(f.code).toBe('INVALID_QUANTITY');
      expectPlain(f);
    }
    expect((await failure(move({ materialId: m.id, type: 'SCRAP_IN', direction: 'IN', quantity: 1, rate: -1 }))).code).toBe('INVALID_RATE');
  });

  it('direction must match the type', async () => {
    const m = await makeMaterial();
    const job = await makeJob();
    expect((await failure(move({ materialId: m.id, type: 'SCRAP_IN', direction: 'OUT', quantity: 1, rate: 0 }))).code).toBe('NOT_ALLOWED');
    expect((await failure(move({ materialId: m.id, type: 'ISSUE', direction: 'IN', quantity: 1, rate: 0, jobId: job.id }))).code).toBe('NOT_ALLOWED');
  });

  it('ISSUE and RETURN must name a job', async () => {
    const m = await makeMaterial();
    for (const [type, direction] of [['ISSUE', 'OUT'], ['RETURN', 'IN']] as const) {
      const f = await failure(move({ materialId: m.id, type, direction, quantity: 1, rate: 0 }));
      expect(f.code).toBe('JOB_REQUIRED');
      expectPlain(f);
    }
  });

  it('RECEIPT needs a receipt line, SCRAP_SALE a scrap sale, REVERSAL the movement it reverses', async () => {
    const m = await makeMaterial();
    expect((await failure(move({ materialId: m.id, type: 'RECEIPT', direction: 'IN', quantity: 1, rate: 1 }))).code).toBe('NOT_ALLOWED');
    expect((await failure(move({ materialId: m.id, type: 'REJECT_RETURN', direction: 'OUT', quantity: 1, rate: 1 }))).code).toBe('NOT_ALLOWED');
    expect((await failure(move({ materialId: m.id, type: 'SCRAP_SALE', direction: 'OUT', quantity: 1, rate: 1 }))).code).toBe('NOT_ALLOWED');
    expect((await failure(move({ materialId: m.id, type: 'REVERSAL', direction: 'OUT', quantity: 1, rate: 1 }))).code).toBe('NOT_ALLOWED');
  });

  it('goods receipt: accepted + rejected must add up to received', async () => {
    const m = await makeMaterial();
    const grn = await prisma.goodsReceipt.create({ data: { number: `GRN-${uid()}`, supplierId: (await makeParty()).id, receiptDate: new Date() } });
    const f = await failure(prisma.goodsReceiptLine.create({
      data: { goodsReceiptId: grn.id, materialId: m.id, receivedQty: 10, acceptedQty: 5, rejectedQty: 6, rate: 1, amount: 10 },
    }));
    expect(f.code).toBe('GRN_SPLIT_MISMATCH');
    expect(f.message).toBe('Accepted and rejected must add up to what was received.');
  });

  it('jobs, BOM lines, PO lines and scrap sales need positive quantities', async () => {
    const customer = await makeParty('customer');
    expect((await failure(makeJob({ customerId: customer.id, quantity: 0 }))).code).toBe('INVALID_QUANTITY');
    const job = await makeJob();
    const m = await makeMaterial();
    expect((await failure(prisma.jobBomLine.create({ data: { jobId: job.id, materialId: m.id, qtyPerPiece: 0, requiredQty: 5 } }))).code).toBe('INVALID_QUANTITY');
    const po = await prisma.purchaseOrder.create({ data: { number: `PO-${uid()}`, supplierId: (await makeParty()).id, poDate: new Date() } });
    expect((await failure(prisma.purchaseOrderLine.create({ data: { purchaseOrderId: po.id, materialId: m.id, quantity: 0, rate: 1, amount: 0 } }))).code).toBe('INVALID_QUANTITY');
    expect((await failure(prisma.scrapSale.create({ data: { number: `SCS-${uid()}`, materialId: m.id, saleDate: new Date(), quantity: 0, rate: 1, amount: 0 } }))).code).toBe('INVALID_QUANTITY');
  });

  it('materials: duplicate names, a missing minimum, bad GST', async () => {
    await makeMaterial({ name: '22 SWG Copper Wire', nameKey: '22swgcopperwire' });
    const dup = await failure(makeMaterial({ name: '22 swg copper-wire', nameKey: '22swgcopperwire' }));
    expect(dup.code).toBe('MATERIAL_EXISTS');
    expectPlain(dup);
    expect((await failure(makeMaterial({ stockType: 'STANDING' }))).code).toBe('MINIMUM_REQUIRED');
    expect((await failure(makeMaterial({ gstRate: 150 }))).code).toBe('INVALID_GST');
    expect((await failure(makeMaterial({ stockType: 'STANDING', minimumLevel: -1 }))).code).toBe('INVALID_MINIMUM');
    await makeMaterial({ stockType: 'STANDING', minimumLevel: 50 }); // fine
  });

  it('parties: GSTIN format and uniqueness, a type is required, a name is unique', async () => {
    const f = await failure(makeParty('supplier', { gstin: '33ABC' }));
    expect(f.code).toBe('INVALID_GSTIN');
    expect(f.message).toContain('33AAACS1234K1Z2');
    await makeParty('supplier', { name: 'Sundaram Ferrites', gstin: '33AAACS1234K1Z2' }); // the example GSTIN is valid
    expect((await failure(makeParty('supplier', { gstin: '33AAACS1234K1Z2' }))).code).toBe('PARTY_EXISTS');
    expect((await failure(makeParty('supplier', { name: 'Sundaram Ferrites' }))).code).toBe('PARTY_EXISTS');
    expect((await failure(makeParty('supplier', { isSupplier: false, isCustomer: false }))).code).toBe('PARTY_TYPE_REQUIRED');
  });

  it('users: emails are lowercase and unique', async () => {
    await prisma.user.create({ data: { name: 'A', email: 'a@test.local', role: 'OWNER', passwordHash: 'x' } });
    expect((await failure(prisma.user.create({ data: { name: 'B', email: 'A@Test.Local', role: 'OWNER', passwordHash: 'x' } }))).code).toBe('INVALID_INPUT');
    expect((await failure(prisma.user.create({ data: { name: 'B', email: 'a@test.local', role: 'OWNER', passwordHash: 'x' } }))).code).toBe('EMAIL_EXISTS');
  });
});

describe('reversals', () => {
  it('a reversal mirrors the original and can happen once', async () => {
    const m = await makeMaterial();
    const job = await makeJob();
    await receive(m.id, 100, 800);
    const out = await issue(m.id, job.id, 50);
    expect(await balance(m.id)).toEqual({ qty: 50, rate: 800, value: 40000 });

    const rev = await move({ materialId: m.id, type: 'REVERSAL', direction: 'IN', quantity: 50, rate: 800, reversalOfId: out.id, jobId: job.id });
    expect(rev.reversalOfId).toBe(out.id);
    expect(await balance(m.id)).toEqual({ qty: 100, rate: 800, value: 80000 });

    const twice = await failure(move({ materialId: m.id, type: 'REVERSAL', direction: 'IN', quantity: 50, rate: 800, reversalOfId: out.id }));
    expect(twice.code).toBe('ALREADY_REVERSED');
    expectPlain(twice);
  });

  it('must be the same material, the same quantity, the opposite direction', async () => {
    const m = await makeMaterial();
    const other = await makeMaterial();
    const job = await makeJob();
    await receive(m.id, 100, 10);
    const out = await issue(m.id, job.id, 50);
    for (const bad of [
      { materialId: m.id, direction: 'IN' as const, quantity: 49 },
      { materialId: m.id, direction: 'OUT' as const, quantity: 50 },
      { materialId: other.id, direction: 'IN' as const, quantity: 50 },
    ]) {
      const f = await failure(move({ type: 'REVERSAL', rate: 10, reversalOfId: out.id, ...bad }));
      expect(f.code).toBe('NOT_ALLOWED');
    }
    expect((await balance(m.id)).qty).toBe(50);
  });

  it('only a REVERSAL may point at another movement', async () => {
    const m = await makeMaterial();
    const job = await makeJob();
    await receive(m.id, 10, 10);
    const out = await issue(m.id, job.id, 1);
    expect((await failure(move({ materialId: m.id, type: 'ISSUE', direction: 'OUT', quantity: 1, rate: 1, jobId: job.id, reversalOfId: out.id }))).code).toBe('NOT_ALLOWED');
  });
});

describe('the opening count', () => {
  async function openingWith(lines: { counted?: number; rate?: number }[]) {
    const mats = await Promise.all(lines.map(() => makeMaterial()));
    const count = await makeCount({ isOpening: true });
    const made = [];
    for (const [i, l] of lines.entries()) made.push(await addLine(count.id, (mats[i] as { id: string }).id, { system: 0, counted: l.counted, rate: l.rate }));
    return { count, mats, lines: made };
  }

  it('cannot be sent to the owner with a material uncounted, or stock without a rate', async () => {
    const a = await openingWith([{ counted: 10, rate: 5 }, {}]);
    const blank = await failure(setCountStatus(a.count.id, 'PENDING_APPROVAL'));
    expect(blank.code).toBe('COUNT_INCOMPLETE');
    expectPlain(blank);

    const b = await openingWith([{ counted: 10 }]); // stock, no rate
    expect((await failure(setCountStatus(b.count.id, 'PENDING_APPROVAL'))).code).toBe('COUNT_INCOMPLETE');

    const c = await openingWith([{ counted: 0 }, { counted: 10, rate: 5 }]); // zero needs no rate
    await setCountStatus(c.count.id, 'PENDING_APPROVAL');
  });

  it('posts OPENING at the line rate, in full, once — ₹1,15,791 worth of copper', async () => {
    const { count, mats, lines } = await openingWith([{ counted: 142.6, rate: 812 }, { counted: 0 }]);
    await approveCount(count.id);
    const mv = await move({ materialId: (mats[0] as { id: string }).id, type: 'OPENING', direction: 'IN', quantity: 142.6, rate: 1, stockCountLineId: (lines[0] as { id: string }).id });
    expect(Number(mv.rate)).toBe(812); // the caller's 1 is ignored: the count line's rate wins
    expect(await balance((mats[0] as { id: string }).id)).toEqual({ qty: 142.6, rate: 812, value: 115791.2 });

    const again = await failure(move({ materialId: (mats[0] as { id: string }).id, type: 'OPENING', direction: 'IN', quantity: 142.6, rate: 812, stockCountLineId: (lines[0] as { id: string }).id }));
    expect(again.code).toBe('ALREADY_POSTED');
  });

  it('OPENING only from an APPROVED count, with exactly the counted quantity, for the right material', async () => {
    const { count, mats, lines } = await openingWith([{ counted: 10, rate: 5 }]);
    const m = (mats[0] as { id: string }).id, l = (lines[0] as { id: string }).id;
    const early = await failure(move({ materialId: m, type: 'OPENING', direction: 'IN', quantity: 10, rate: 5, stockCountLineId: l }));
    expect(early.code).toBe('COUNT_NOT_APPROVED');
    await approveCount(count.id);
    expect((await failure(move({ materialId: m, type: 'OPENING', direction: 'IN', quantity: 9, rate: 5, stockCountLineId: l }))).code).toBe('NOT_ALLOWED');
    const other = await makeMaterial();
    expect((await failure(move({ materialId: other.id, type: 'OPENING', direction: 'IN', quantity: 10, rate: 5, stockCountLineId: l }))).code).toBe('NOT_ALLOWED');
    expect((await balance(m)).qty).toBe(0);
  });

  it('no OPENING row at all without a count line (the CHECK)', async () => {
    const m = await makeMaterial();
    const f = await failure(move({ materialId: m.id, type: 'OPENING', direction: 'IN', quantity: 10, rate: 5 }));
    expect(f.code).toBe('COUNT_NOT_APPROVED');
  });

  it('only one opening count can ever be approved', async () => {
    const first = await openingWith([{ counted: 1, rate: 1 }]);
    await approveCount(first.count.id);
    const second = await openingWith([{ counted: 2, rate: 2 }]);
    await setCountStatus(second.count.id, 'PENDING_APPROVAL');
    const f = await failure(setCountStatus(second.count.id, 'APPROVED'));
    expect(f.code).toBe('OPENING_ALREADY_DONE');
    expectPlain(f);
  });

  it('a normal count cannot post OPENING, and the opening count cannot post COUNT_ADJUSTMENT', async () => {
    const m = await makeMaterial();
    const normal = await makeCount();
    const nl = await addLine(normal.id, m.id, { system: 0, counted: 5, reason: 'MISSING' });
    await approveCount(normal.id);
    expect((await failure(move({ materialId: m.id, type: 'OPENING', direction: 'IN', quantity: 5, rate: 1, stockCountLineId: nl.id }))).code).toBe('NOT_ALLOWED');

    const op = await openingWith([{ counted: 5, rate: 2 }]);
    await approveCount(op.count.id);
    expect((await failure(move({ materialId: (op.mats[0] as { id: string }).id, type: 'COUNT_ADJUSTMENT', direction: 'IN', quantity: 5, rate: 2, stockCountLineId: (op.lines[0] as { id: string }).id }))).code).toBe('NOT_ALLOWED');
  });
});

describe('normal counts', () => {
  async function stocked(qty: number, rate: number) {
    const m = await makeMaterial();
    await receive(m.id, qty, rate);
    return m;
  }

  it('stock only moves when the owner approves, by exactly the difference', async () => {
    const m = await stocked(100, 800);
    const count = await makeCount();
    const line = await addLine(count.id, m.id, { system: 100, counted: 97.4, reason: 'SPILLAGE' });

    const draft = await failure(move({ materialId: m.id, type: 'COUNT_ADJUSTMENT', direction: 'OUT', quantity: 2.6, rate: 1, stockCountLineId: line.id }));
    expect(draft.code).toBe('COUNT_NOT_APPROVED');

    await approveCount(count.id);
    for (const bad of [
      { direction: 'OUT' as const, quantity: 2 },     // wrong quantity
      { direction: 'IN' as const, quantity: 2.6 },    // wrong way
    ]) expect((await failure(move({ materialId: m.id, type: 'COUNT_ADJUSTMENT', rate: 1, stockCountLineId: line.id, ...bad }))).code).toBe('NOT_ALLOWED');
    expect((await balance(m.id)).qty).toBe(100);

    await move({ materialId: m.id, type: 'COUNT_ADJUSTMENT', direction: 'OUT', quantity: 2.6, rate: 1, stockCountLineId: line.id });
    expect(await balance(m.id)).toEqual({ qty: 97.4, rate: 800, value: 77920 });
  });

  it('a line that matched (difference 0) can post nothing', async () => {
    const m = await stocked(10, 10);
    const count = await makeCount();
    const line = await addLine(count.id, m.id, { system: 10, counted: 10 });
    await approveCount(count.id);
    expect((await failure(move({ materialId: m.id, type: 'COUNT_ADJUSTMENT', direction: 'IN', quantity: 1, rate: 1, stockCountLineId: line.id }))).code).toBe('NOT_ALLOWED');
  });

  it('an uncounted line cannot go to the owner; a difference must be counted − system', async () => {
    const m = await stocked(10, 10);
    const count = await makeCount();
    await addLine(count.id, m.id, { system: 10 });
    expect((await failure(setCountStatus(count.id, 'PENDING_APPROVAL'))).code).toBe('COUNT_INCOMPLETE');
    const line = await prisma.stockCountLine.findFirstOrThrow({ where: { stockCountId: count.id } });
    const f = await failure(prisma.stockCountLine.update({ where: { id: line.id }, data: { countedQty: 8, differenceQty: -1 } }));
    expect(f.code).toBe('COUNT_DIFFERENCE_MISMATCH');
  });

  it('rate must be more than zero; reason must be one of the five', async () => {
    const m = await stocked(10, 10);
    const count = await makeCount({ isOpening: false });
    expect((await failure(addLine(count.id, m.id, { system: 10, counted: 9, rate: 0 }))).code).toBe('RATE_REQUIRED');
    expect((await failure(addLine(count.id, m.id, { system: 10, counted: 9, reason: 'GUESS' }))).code).toBe('INVALID_REASON');
    expect((await failure(addLine(count.id, m.id, { system: 10, counted: -1 }))).code).toBe('INVALID_QUANTITY');
  });

  it('only a count that went to the owner can be approved', async () => {
    const m = await stocked(10, 10);
    const count = await makeCount();
    await addLine(count.id, m.id, { system: 10, counted: 10 });
    const f = await failure(setCountStatus(count.id, 'APPROVED'));
    expect(f.code).toBe('NOT_PENDING');
  });

  it('while with the owner, and after approval, nothing about it can change', async () => {
    const m = await stocked(10, 10);
    const count = await makeCount();
    const line = await addLine(count.id, m.id, { system: 10, counted: 9, reason: 'MISSING' });
    await setCountStatus(count.id, 'PENDING_APPROVAL');
    expect((await failure(prisma.stockCountLine.update({ where: { id: line.id }, data: { countedQty: 5, differenceQty: -5 } }))).code).toBe('COUNT_LOCKED');

    await setCountStatus(count.id, 'APPROVED');
    expect((await failure(setCountStatus(count.id, 'DRAFT'))).code).toBe('COUNT_LOCKED');
    expect((await failure(prisma.stockCountLine.update({ where: { id: line.id }, data: { reasonCode: 'ENTRY_ERROR' } }))).code).toBe('COUNT_LOCKED');
  });

  it('sent back: the storekeeper may fix the same count; the system quantity stays frozen', async () => {
    const m = await stocked(10, 10);
    const count = await makeCount();
    const line = await addLine(count.id, m.id, { system: 10, counted: 9, reason: 'MISSING' });
    await setCountStatus(count.id, 'PENDING_APPROVAL');
    await setCountStatus(count.id, 'REJECTED');
    await prisma.stockCountLine.update({ where: { id: line.id }, data: { countedQty: 10, differenceQty: 0, reasonCode: null } });
    const frozen = await failure(prisma.stockCountLine.update({ where: { id: line.id }, data: { systemQty: 9, differenceQty: 1 } }));
    expect(frozen.code).toBe('COUNT_LOCKED');
    await setCountStatus(count.id, 'PENDING_APPROVAL'); // resubmitted
  });

  it('counts and their lines are never deleted', async () => {
    const m = await stocked(1, 1);
    const count = await makeCount();
    const line = await addLine(count.id, m.id, { system: 1, counted: 1 });
    expect((await failure(prisma.stockCountLine.delete({ where: { id: line.id } }))).code).toBe('COUNT_LOCKED');
    expect((await failure(prisma.stockCount.delete({ where: { id: count.id } }))).code).toBe('COUNT_LOCKED');
  });
});

describe('two people at once', () => {
  it('25 simultaneous issues each see the true balance — no lost updates, no duplicates', async () => {
    const m = await makeMaterial();
    const job = await makeJob();
    await receive(m.id, 1000, 10);
    const rows = await Promise.all(Array.from({ length: 25 }, () => issue(m.id, job.id, 1)));
    expect((await balance(m.id)).qty).toBe(975);
    const stamped = rows.map((r) => Number(r.balanceQtyAfter)).sort((a, b) => b - a);
    expect(stamped).toEqual(Array.from({ length: 25 }, (_, i) => 999 - i)); // 999, 998 … 975: each saw the one before
  });

  it('mixed receipts, issues and returns at once still reconcile', async () => {
    const m = await makeMaterial();
    const job = await makeJob();
    await receive(m.id, 100, 10);
    await Promise.all([
      ...Array.from({ length: 10 }, () => issue(m.id, job.id, 2)),
      ...Array.from({ length: 10 }, () => receive(m.id, 3, 10)),
      ...Array.from({ length: 5 }, () => giveBack(m.id, job.id, 1)),
    ]);
    expect((await balance(m.id)).qty).toBe(100 - 20 + 30 + 5);
  });
});

describe('the reports (views)', () => {
  it('leak report: opening excluded, only real differences are unexplained', async () => {
    const copper = await makeMaterial({ name: 'Copper' });
    const core = await makeMaterial({ name: 'Core' });

    const opening = await makeCount({ isOpening: true });
    const ol = await addLine(opening.id, copper.id, { system: 0, counted: 100, rate: 800 });
    await addLine(opening.id, core.id, { system: 0, counted: 50, rate: 65 });
    await approveCount(opening.id);
    await move({ materialId: copper.id, type: 'OPENING', direction: 'IN', quantity: 100, rate: 1, stockCountLineId: ol.id });

    const count = await makeCount();
    await addLine(count.id, copper.id, { system: 100, counted: 90, reason: 'UNEXPLAINED' });  // real difference, unexplained
    await addLine(count.id, core.id, { system: 50, counted: 50 });                              // matched, no reason: NOT unexplained
    await approveCount(count.id);

    const rows = await prisma.$queryRaw<{ material_name: string; times_counted: bigint; times_mismatched: bigint; total_shortage_qty: string; unexplained_count: bigint; total_variance_value: string }[]>`
      SELECT * FROM v_material_leak ORDER BY material_name`;
    const copperRow = rows.find((r) => r.material_name === 'Copper');
    const coreRow = rows.find((r) => r.material_name === 'Core');
    expect(copperRow).toMatchObject({ times_counted: 1n, times_mismatched: 1n, unexplained_count: 1n });
    expect(Number(copperRow?.total_shortage_qty)).toBe(10);
    expect(Number(copperRow?.total_variance_value)).toBe(10 * 800);
    expect(coreRow).toMatchObject({ times_counted: 1n, times_mismatched: 0n, unexplained_count: 0n });
  });

  it('job material cost = issued − returned, per piece', async () => {
    const m = await makeMaterial();
    const job = await makeJob({ quantity: 100 });
    await receive(m.id, 100, 800);
    await issue(m.id, job.id, 50);
    await giveBack(m.id, job.id, 10);
    const [row] = await prisma.$queryRaw<{ issued_value: string; returned_value: string; net_material_cost: string; material_cost_per_piece: string }[]>`
      SELECT * FROM v_job_material_cost WHERE job_id = ${job.id}`;
    expect(Number(row?.issued_value)).toBe(40000);
    expect(Number(row?.returned_value)).toBe(8000);
    expect(Number(row?.net_material_cost)).toBe(32000);
    expect(Number(row?.material_cost_per_piece)).toBe(320);
  });

  it('BOM vs actual: variance and percentage', async () => {
    const m = await makeMaterial({ name: 'Wire' });
    const job = await makeJob({ number: 'JOB-2627-0031' });
    await prisma.jobBomLine.create({ data: { jobId: job.id, materialId: m.id, qtyPerPiece: 1, requiredQty: 100, issuedQty: 110, returnedQty: 5 } });
    const [row] = await prisma.$queryRaw<{ net_consumed: string; variance: string; variance_pct: string }[]>`SELECT * FROM v_bom_vs_actual WHERE job_number = 'JOB-2627-0031'`;
    expect([Number(row?.net_consumed), Number(row?.variance), Number(row?.variance_pct)]).toEqual([105, 5, 5]);
  });

  it('reorder alerts: standing, active, below minimum only', async () => {
    const low = await makeMaterial({ name: 'Low', stockType: 'STANDING', minimumLevel: 50 });
    const fine = await makeMaterial({ name: 'Fine', stockType: 'STANDING', minimumLevel: 5 });
    await makeMaterial({ name: 'PerJob' });
    await makeMaterial({ name: 'Retired', stockType: 'STANDING', minimumLevel: 50, isActive: false });
    await receive(low.id, 18, 65);
    await receive(fine.id, 10, 65);
    const rows = await prisma.$queryRaw<{ name: string; on_hand: string; shortfall: string }[]>`SELECT * FROM v_reorder_alerts`;
    expect(rows.map((r) => r.name)).toEqual(['Low']);
    expect(Number(rows[0]?.shortfall)).toBe(32);
  });
});
