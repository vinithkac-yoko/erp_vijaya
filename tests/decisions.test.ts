import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { importDecisions, parseConfirmations, parseOptions } from '@/server/tools/decisions-import';
import { sentMail } from '@/server/tools/email';
import { pendingActions, runTool } from '@/server/tools';
import { prisma, resetDb } from './helpers/db';
import { fails, ok, owner, save, seedSettings, storekeeper } from './helpers/tools';

beforeEach(async () => { await resetDb(); await seedSettings(); });
afterAll(() => prisma.$disconnect());

const md = readFileSync('docs/CLIENT_CONFIRMATIONS.md', 'utf8');

describe('the questions are read from the confirmations file', () => {
  it('every question table row becomes a question; the answers table and the notes are not questions', () => {
    const all = parseConfirmations(md);
    expect(all.length).toBeGreaterThan(130);
    expect(new Set(all.map((d) => d.key)).size).toBe(all.length);
    expect(all.some((d) => d.key === 'M19')).toBe(true);
    expect(all.some((d) => /^Kasi's answers/.test(d.question))).toBe(false);
    for (const d of all) { expect(d.question.length).toBeGreaterThan(5); expect(d.options.length).toBeGreaterThan(0); expect(d.topic).not.toMatch(/^Added/i); }
    // topics read as a person would say them
    const topics = [...new Set(all.map((d) => d.topic))];
    expect(topics).toContain('Money and stock');
    expect(topics).toContain('Part numbers, their PO and work order');
    // a few for the owner first, not all of them
    const first = all.filter((d) => d.firstPass).length;
    expect(first).toBeGreaterThanOrEqual(15); expect(first).toBeLessThanOrEqual(25);
    expect(all.some((d) => d.agreedByKasi)).toBe(true);
  });

  it('the boxes in "Owner says" become the choices; "Change: ___" asks for his own words; a blank gets the usual two; a prompt is a write-in', () => {
    expect(parseOptions('☐ OK ☐ Change: ')).toEqual([{ value: 'ok', label: 'OK' }, { value: 'change', label: 'Change', writeIn: true }]);
    expect(parseOptions('☐ 5% ☐ Lower: ___%').map((o) => [o.label, !!o.writeIn])).toEqual([['5%', false], ['Lower', true]]);
    expect(parseOptions('').map((o) => o.value)).toEqual(['ok', 'change']);
    expect(parseOptions('Which address: ____________')).toEqual([{ value: 'answer', label: 'Which address', writeIn: true }]);
  });

  it('importing twice adds nothing new, and never touches an answer; new wording is kept current', async () => {
    const a = await importDecisions(prisma, md);
    expect(a.added).toBeGreaterThan(130);
    const o = await owner();
    const q = await prisma.decision.findFirstOrThrow({ where: { key: 'L9' } });
    await ok(save(o, 'answer_decision', { decisionId: q.id, choice: 'OK' }));
    const b = await importDecisions(prisma, md.replace('How long a login lasts.', 'How long a login lasts (reworded).'));
    expect(b.added).toBe(0);
    const after = await prisma.decision.findUniqueOrThrow({ where: { id: q.id } });
    expect(after).toMatchObject({ status: 'ANSWERED', answerChoice: 'OK' });
    expect(after.question).toContain('reworded');
  });
});

describe('the owner answers; nobody else sees the questions', () => {
  async function world() { await importDecisions(prisma, md); return { o: await owner(), s: await storekeeper() }; }

  it('the storekeeper has no tool for any of them (the assistant is never offered them for him either)', async () => {
    const { s } = await world();
    for (const tool of ['list_decisions', 'get_decision', 'answer_decision', 'set_decision_status']) expect(await runTool(s, tool, { decisionId: 'x', choice: 'OK', status: 'LATER' })).toMatchObject({ ok: false });
  });

  it('list_decisions counts what is waiting, what he answered, what waits for the client and what is for later', async () => {
    const { o } = await world();
    const all = await ok<{ counts: { toAnswer: number; firstPassToAnswer: number; answered: number }; rows: { id: string; question: string }[] }>(runTool(o, 'list_decisions', {}));
    expect(all.counts.answered).toBe(0);
    await ok(save(o, 'answer_decision', { decisionId: all.rows[0]!.id, choice: 'OK' }));
    const first = await ok<{ counts: { toAnswer: number; answered: number }; rows: unknown[] }>(runTool(o, 'list_decisions', { firstPassOnly: true, status: 'OPEN' }));
    expect(first.counts.answered).toBe(1);
    expect(first.rows.length).toBeLessThanOrEqual(25);
  });

  it('an answer must be one of the choices, a "Change" needs his words, and it is kept with who and when, and in the audit log', async () => {
    const { o } = await world();
    const d = await prisma.decision.findFirstOrThrow({ where: { key: 'L9' } });
    expect((await fails(save(o, 'answer_decision', { decisionId: d.id, choice: 'Maybe' }))).code).toBe('INVALID_CHOICE');
    expect((await fails(save(o, 'answer_decision', { decisionId: d.id, choice: 'Change' }))).code).toBe('NOTE_REQUIRED');
    await ok(save(o, 'answer_decision', { decisionId: d.id, choice: 'change', note: 'Storekeeper 8 hours' }));
    const got = await prisma.decision.findUniqueOrThrow({ where: { id: d.id } });
    expect(got).toMatchObject({ status: 'ANSWERED', answerChoice: 'Change', answerNote: 'Storekeeper 8 hours', answeredById: o.userId });
    expect(got.answeredAt).toBeInstanceOf(Date);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { entityType: 'Decision', entityId: d.id, action: 'ANSWER' } });
    expect(ev.actorId).toBe(o.userId);
  });

  it('"later", "waiting for the client" and "back to answer" move a question; an answer he gave stays until he answers again', async () => {
    const { o } = await world();
    const d = await prisma.decision.findFirstOrThrow({ where: { key: 'M11' } });
    await ok(save(o, 'set_decision_status', { decisionId: d.id, status: 'NEEDS_CLIENT', note: 'Ask Kumar at the accounts desk' }));
    expect(await prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'NEEDS_CLIENT', statusNote: 'Ask Kumar at the accounts desk' });
    await ok(save(o, 'set_decision_status', { decisionId: d.id, status: 'LATER' }));
    await ok(save(o, 'set_decision_status', { decisionId: d.id, status: 'OPEN' }));
    expect((await prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('OPEN');
    expect((await fails(save(o, 'set_decision_status', { decisionId: d.id, status: 'ANSWERED' }))).ok).toBe(false);
  });

  it('get_decision finds a question by the words he uses, explains it, and says when two fit', async () => {
    const { o } = await world();
    const g = await ok<{ question: string; options: { label: string }[]; history: unknown[] }>(runTool(o, 'get_decision', { decisionId: 'company letterhead printouts' }));
    expect(g.question).toMatch(/letterhead/i);
    expect(g.options.length).toBeGreaterThanOrEqual(1);
    const amb = await runTool(o, 'get_decision', { decisionId: 'owner' });
    expect(amb).toMatchObject({ ok: false });
    expect(JSON.stringify(amb)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('the answer form offers that question\'s own choices, and Kasi gets a short note by email when it is set up', async () => {
    const { o } = await world();
    const d = await prisma.decision.findFirstOrThrow({ where: { key: 'L9' } });
    const pv = await pendingActions.previewFor(o, 'answer_decision', { decisionId: d.id });
    expect((pv as unknown as { values: Record<string, unknown> }).values.decisionId).toBe(d.id);
    const before = sentMail.length;
    process.env.SMTP_URL = 'json:'; process.env.DECISIONS_NOTIFY_EMAIL = 'kasi@example.com';
    try {
      await ok(save(o, 'answer_decision', { decisionId: d.id, choice: 'OK' }));
      await new Promise((r) => setTimeout(r, 50));
      expect(sentMail.length).toBe(before + 1);
      expect(sentMail.at(-1)).toMatchObject({ to: 'kasi@example.com', subject: 'The owner answered a question' });
      expect(sentMail.at(-1)?.text).toMatch(/Answer: OK/);
    } finally { delete process.env.SMTP_URL; delete process.env.DECISIONS_NOTIFY_EMAIL; }
  });
});
