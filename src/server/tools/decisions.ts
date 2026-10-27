import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Card } from '@/lib/cards';
import { dateText } from '@/lib/format';
import { search } from '@/lib/similar';
import { ToolError } from '../errors';
import type { Choice } from './decisions-import';
import { defineTool } from './define';
import { sendDecisionNotice } from './email';
import { flag, opt } from './helpers';
import type { Db } from './types';

/**
 * Decisions (milestone 12): the questions only the owner can answer, with what we did meanwhile. Owner only: the storekeeper
 * has no tool for these and the assistant is never offered them for him. An answer is a form the owner presses, like every
 * write; the panel in the app presses the same button for him. Every answer is an AuditEvent as well.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_TEXT = { OPEN: 'To answer', ANSWERED: 'Answered', NEEDS_CLIENT: 'Waiting for the client', LATER: 'Later' } as const;
type Status = keyof typeof STATUS_TEXT;

const rowOf = (d: Prisma.DecisionGetPayload<object>) => ({
  id: d.id, topic: d.topic, question: d.question, whatWeDid: d.whatWeDid, why: d.why, options: d.options as unknown as Choice[], status: d.status, statusText: STATUS_TEXT[d.status],
  firstPass: d.firstPass, agreedByKasi: d.agreedByKasi, answer: d.answerChoice, note: d.answerNote, statusNote: d.statusNote, answeredAt: d.answeredAt?.toISOString() ?? null,
});

/** A decision by its id, or by words from its question (as the owner says it). Never guesses between two. */
export async function findDecision(db: Db, ref: string) {
  const r = ref.trim();
  if (UUID.test(r)) { const d = await db.decision.findUnique({ where: { id: r } }); if (d) return d; }
  else if (r) {
    const all = await db.decision.findMany({ orderBy: { position: 'asc' } });
    const hits = search(r, all, (d) => d.question.toLowerCase().replace(/[^a-z0-9]+/g, ''), (d) => d.question);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) throw new ToolError('DECISION_AMBIGUOUS', `Which question? ${hits.slice(0, 3).map((h) => `"${h.question.slice(0, 70)}"`).join(' or ')}.`, undefined, 'decisionId');
  }
  throw new ToolError('NOT_FOUND', "Couldn't find that question.", undefined, 'decisionId');
}

// ── list_decisions ─────────────────────────────────────────────────────────────────────────────────
export const listDecisions = defineTool({
  name: 'list_decisions', kind: 'read', roles: ['OWNER'],
  input: z.object({ status: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['OPEN', 'ANSWERED', 'NEEDS_CLIENT', 'LATER']).optional()), topic: opt(80), query: opt(100), firstPassOnly: flag.optional() }),
  handler: async (ctx, input) => {
    let all = await ctx.db.decision.findMany({ orderBy: [{ position: 'asc' }] });
    const counts = { toAnswer: all.filter((d) => d.status === 'OPEN').length, firstPassToAnswer: all.filter((d) => d.status === 'OPEN' && d.firstPass).length, answered: all.filter((d) => d.status === 'ANSWERED').length, waitingForClient: all.filter((d) => d.status === 'NEEDS_CLIENT').length, later: all.filter((d) => d.status === 'LATER').length };
    if (input.status) all = all.filter((d) => d.status === input.status);
    if (input.firstPassOnly) all = all.filter((d) => d.firstPass);
    if (input.topic) all = all.filter((d) => d.topic.toLowerCase().includes(input.topic!.toLowerCase()));
    if (input.query) all = search(input.query, all, (d) => d.question.toLowerCase().replace(/[^a-z0-9]+/g, ''), (d) => d.question);
    return { counts, topics: [...new Set(all.map((d) => d.topic))], rows: all.slice(0, 200).map(rowOf) };
  },
  view: (d) => [{
    kind: 'table', title: `${d.counts.toAnswer} to answer · ${d.counts.answered} answered · ${d.counts.waitingForClient} waiting for the client · ${d.counts.later} for later`,
    columns: [{ key: 'q', label: 'Question' }, { key: 's', label: 'Where it stands' }, { key: 'a', label: 'Your answer' }],
    rows: d.rows.slice(0, 10).map((r) => ({ q: r.question.length > 90 ? `${r.question.slice(0, 88)}…` : r.question, s: r.statusText, a: r.answer ?? '–' })),
    note: d.rows.length === 0 ? 'No question like that.' : d.rows.length > 10 ? `Showing 10 of ${d.rows.length}. The Decisions button has them all.` : undefined,
  } satisfies Card],
});

// ── get_decision ───────────────────────────────────────────────────────────────────────────────────
export const getDecision = defineTool({
  name: 'get_decision', kind: 'read', roles: ['OWNER'],
  input: z.object({ decisionId: z.string({ required_error: 'Which question?' }).min(1, 'Which question?').max(200) }),
  handler: async (ctx, input) => {
    const d = await findDecision(ctx.db, input.decisionId);
    const events = await ctx.db.auditEvent.findMany({ where: { entityType: 'Decision', entityId: d.id }, orderBy: { createdAt: 'desc' }, take: 10, select: { createdAt: true, action: true, afterJson: true } });
    return { ...rowOf(d), history: events.map((e) => ({ at: e.createdAt.toISOString(), what: e.action === 'ANSWER' ? 'Answered' : 'Moved', answer: (e.afterJson as { choice?: string; status?: string } | null)?.choice ?? (e.afterJson as { statusText?: string } | null)?.statusText ?? null })) };
  },
  view: (d) => [{
    kind: 'table', title: d.question, columns: [{ key: 'k', label: '' }, { key: 'v', label: '' }],
    rows: [{ k: 'What we did', v: d.whatWeDid || d.why || '–' }, ...(d.whatWeDid && d.why ? [{ k: 'Why', v: d.why }] : []), { k: 'Choices', v: d.options.map((o) => o.label).join(' · ') }, { k: 'Where it stands', v: d.statusText + (d.answer ? `: ${d.answer}` : '') }],
  } satisfies Card],
});

// ── answer_decision ────────────────────────────────────────────────────────────────────────────────
export const answerDecision = defineTool({
  name: 'answer_decision', kind: 'write', roles: ['OWNER'],
  input: z.object({
    decisionId: z.string({ required_error: 'Which question?' }).min(1, 'Which question?').max(200),
    choice: z.string({ required_error: 'Choose an answer.' }).trim().min(1, 'Choose an answer.').max(120),
    note: opt(1000),
  }),
  form: {
    title: 'Answer a question', verb: 'Save my answer',
    intro: 'Your answer is kept with the date. You can change it later.',
    fields: [
      { name: 'decisionId', label: 'Question', type: 'hidden' },
      { name: 'choice', label: 'Your answer', type: 'select', required: true },
      { name: 'note', label: 'In your own words (if you want to add something)', type: 'textarea' },
    ],
  },
  stamp: 'ANSWER SAVED',
  describe: (a) => [String(a.question), `Your answer: ${a.choice}`, ...(a.note ? [`You added: ${a.note}`] : [])],
  preview: async (ctx, input) => {
    if (typeof input.decisionId !== 'string' || !input.decisionId) return { info: [], values: {} };
    try {
      const d = await findDecision(ctx.db, input.decisionId);
      const r = rowOf(d);
      const info = [r.question, ...(r.whatWeDid ? [`What we did: ${r.whatWeDid}`] : r.why ? [`Why it matters: ${r.why}`] : [])];
      return { info, values: { decisionId: d.id }, decorate: { choiceOptions: r.options.map((o) => ({ value: o.label, label: o.writeIn ? `${o.label} (say how, below)` : o.label })) } };
    } catch (e) { return { info: [e instanceof ToolError ? e.message : 'Which question?'], values: {} }; }
  },
  handler: async (ctx, input) => {
    const d = await findDecision(ctx.db, input.decisionId);
    const options = d.options as unknown as Choice[];
    const want = input.choice.toLowerCase();
    const chosen = options.find((o) => o.label.toLowerCase() === want || o.value === want);
    if (!chosen) throw new ToolError('INVALID_CHOICE', `Choose one of: ${options.map((o) => o.label).join(', ')}.`, undefined, 'choice');
    if (chosen.writeIn && !input.note) throw new ToolError('NOTE_REQUIRED', `Say in your own words what you want for "${chosen.label}".`, undefined, 'note');
    await ctx.db.decision.update({ where: { id: d.id }, data: { status: 'ANSWERED', answerChoice: chosen.label, answerNote: input.note ?? null, answeredAt: ctx.now, answeredById: ctx.session.userId, statusNote: null } });
    return {
      data: { id: d.id, question: d.question, choice: chosen.label },
      audit: { entityType: 'Decision', entityId: d.id, action: 'ANSWER', before: { status: d.status, choice: d.answerChoice, note: d.answerNote }, after: { question: d.question, choice: chosen.label, note: input.note ?? null } },
      afterCommit: async () => {
        void sendDecisionNotice('The owner answered a question', `Question: ${d.question}\nAnswer: ${chosen.label}${input.note ? `\nHe added: ${input.note}` : ''}\n\n(Vijaya Stores, ${dateText(ctx.now)})`);
      },
    };
  },
});

// ── set_decision_status ────────────────────────────────────────────────────────────────────────────
export const setDecisionStatus = defineTool({
  name: 'set_decision_status', kind: 'write', roles: ['OWNER'],
  input: z.object({
    decisionId: z.string({ required_error: 'Which question?' }).min(1, 'Which question?').max(200),
    status: z.enum(['OPEN', 'NEEDS_CLIENT', 'LATER'], { errorMap: () => ({ message: 'Choose: later, waiting for the client, or to answer.' }) }),
    note: opt(400),
  }),
  form: {
    title: 'Move a question', verb: 'Save',
    intro: 'Put a question aside for later, mark it as waiting for someone else to say, or bring it back to answer.',
    fields: [
      { name: 'decisionId', label: 'Question', type: 'hidden' },
      { name: 'status', label: 'Where should it go?', type: 'select', required: true, options: [{ value: 'LATER', label: 'Later' }, { value: 'NEEDS_CLIENT', label: 'Waiting for the client to say' }, { value: 'OPEN', label: 'Back to "to answer"' }] },
      { name: 'note', label: 'A note (who to ask, or why)', type: 'text' },
    ],
  },
  stamp: 'QUESTION MOVED',
  describe: (a) => [String(a.question), `Now: ${a.statusText}`, ...(a.note ? [`Note: ${a.note}`] : [])],
  preview: async (ctx, input) => {
    if (typeof input.decisionId !== 'string' || !input.decisionId) return { info: [], values: {} };
    try { const d = await findDecision(ctx.db, input.decisionId); return { info: [d.question], values: { decisionId: d.id } }; } catch (e) { return { info: [e instanceof ToolError ? e.message : 'Which question?'], values: {} }; }
  },
  handler: async (ctx, input) => {
    const d = await findDecision(ctx.db, input.decisionId);
    const status = input.status as Status;
    // an answered question moved back keeps what he said until he answers again
    await ctx.db.decision.update({ where: { id: d.id }, data: { status, statusNote: input.note ?? null } });
    return {
      data: { id: d.id, question: d.question, status },
      audit: { entityType: 'Decision', entityId: d.id, action: 'STATUS', before: { status: d.status }, after: { question: d.question, statusText: STATUS_TEXT[status], note: input.note ?? null } },
    };
  },
});
