import { z } from 'zod';
import type { Card } from '@/lib/cards';
import { dateText } from '@/lib/format';
import { ToolError } from '../../errors';
import { defineTool } from '../define';
import { id } from '../helpers';
import type { Db, ToolSession } from '../types';
import { cardsOf, canUndoUntil, planFor, UNDO_DAYS, viewOf, type StoredPlan } from './draft';
import { executeSteps, undoSteps, type RunResult, type StepResult } from './execute';
import type { Spec, Step } from './types';
import { db } from '../../db';

/**
 * The registry side of imports (milestone 16, owner only): read an import, apply it, undo it. Applying and undoing are writes like any
 * other: the assistant only opens the form, the owner's press is what runs them. The planning itself (propose / revise) is in the assistant's
 * own tools (docs/TOOL_CATALOG.md §B) because it saves nothing in the business.
 */
const STATUS_TEXT = { DRAFT: 'A proposal (not applied)', APPLIED: 'Applied', DISCARDED: 'Thrown away', UNDONE: 'Undone' } as const;
const draftId = id('import');

async function own(client: Db, session: ToolSession, draftIdValue: string) {
  const row = await client.importDraft.findFirst({ where: { id: draftIdValue, userId: session.userId } });
  if (!row) throw new ToolError('NOT_FOUND', "I can't find that import.", undefined, 'draftId');
  return row;
}

const tally = (steps: StepResult[]) => ({ done: steps.filter((s) => s.status === 'done').length, skipped: steps.filter((s) => s.status === 'skipped').length, failed: steps.filter((s) => s.status === 'failed').length });
const problemsOf = (steps: StepResult[]) => steps.filter((s) => s.status !== 'done' || s.message).slice(0, 25).map((s) => ({ what: s.label, outcome: s.status === 'done' ? 'done, with a note' : s.status === 'skipped' ? 'not done' : 'failed', reason: s.message ?? '' }));

// ── list_imports ───────────────────────────────────────────────────────────────────────────────────
export const listImports = defineTool({
  name: 'list_imports', kind: 'read', roles: ['OWNER'],
  input: z.object({}),
  handler: async (ctx) => {
    const rows = await ctx.db.importDraft.findMany({ where: { userId: ctx.session.userId, status: { not: 'DISCARDED' } }, orderBy: { createdAt: 'desc' }, take: 10 });
    const now = ctx.now.getTime();
    return {
      rows: rows.map((r) => {
        const until = canUndoUntil(r.appliedAt);
        return { id: r.id, title: r.title, status: r.status, statusText: STATUS_TEXT[r.status], when: (r.appliedAt ?? r.createdAt).toISOString(), summary: (r.plan as unknown as StoredPlan).lines.join('; '), canUndo: r.status === 'APPLIED' && !!until && until.getTime() > now, undoUntil: until && r.status === 'APPLIED' ? until.toISOString() : null };
      }),
    };
  },
  view: (d) => [{
    kind: 'table', title: 'Imports', columns: [{ key: 't', label: 'Import' }, { key: 's', label: 'Where it stands' }, { key: 'w', label: 'When' }],
    rows: d.rows.map((r) => ({ t: r.title, s: r.statusText + (r.canUndo ? ` · can be undone until ${dateText(new Date(r.undoUntil!))}` : ''), w: dateText(new Date(r.when)) })),
    note: d.rows.length === 0 ? 'Nothing has been imported yet.' : undefined,
  } satisfies Card],
});

// ── get_import_draft ───────────────────────────────────────────────────────────────────────────────
export const getImportDraft = defineTool({
  name: 'get_import_draft', kind: 'read', roles: ['OWNER'],
  input: z.object({ draftId }),
  handler: async (ctx, input) => {
    const row = await own(ctx.db, ctx.session, input.draftId);
    const result = row.result as unknown as RunResult | null;
    return {
      ...viewOf(row), statusText: STATUS_TEXT[row.status],
      ...(result ? { result: { finished: result.finished, ...tally(result.steps), notDone: problemsOf(result.steps), ...(result.undo ? { undone: { finished: result.undo.finished, ...tally(result.undo.steps), notUndone: problemsOf(result.undo.steps) } } : {}) } } : {}),
    };
  },
  view: (d) => draftCards(d),
});

/** The cards for an import: what it will change, or, once applied, what happened (and what was not done). */
function draftCards(d: { title: string; willDo: string[]; result?: unknown }): Card[] {
  const cards: Card[] = [];
  const res = d.result as { done: number; skipped: number; failed: number; notDone: { what: string; outcome: string; reason: string }[]; undone?: { done: number; skipped: number; failed: number } } | undefined;
  if (res) {
    cards.push({ kind: 'table', title: `${d.title}: what happened`, columns: [{ key: 'k', label: 'Changes' }, { key: 'n', label: 'How many', align: 'right' }], rows: [{ k: 'Done', n: String(res.done) }, { k: 'Not done', n: String(res.skipped) }, { k: 'Failed', n: String(res.failed) }, ...(res.undone ? [{ k: 'Undone', n: String(res.undone.done) }] : [])] });
    if (res.notDone.length) cards.push({ kind: 'table', title: 'Not done', columns: [{ key: 'w', label: 'What' }, { key: 'r', label: 'Why' }], rows: res.notDone.slice(0, 10).map((x) => ({ w: x.what, r: x.reason || x.outcome })), note: res.notDone.length > 10 ? `Showing 10 of ${res.notDone.length}.` : undefined });
  } else {
    cards.push({ kind: 'table', title: d.title, columns: [{ key: 'w', label: 'What will change' }], rows: d.willDo.map((w) => ({ w })) });
  }
  return cards;
}

// ── apply_import ───────────────────────────────────────────────────────────────────────────────────
export const applyImport = defineTool({
  name: 'apply_import', kind: 'write', roles: ['OWNER'],
  input: z.object({ draftId }),
  form: {
    title: 'Apply the changes from your files', verb: 'Apply',
    intro: `These changes are saved straight away, one by one, with the same rules as the forms. You can undo them for ${UNDO_DAYS} days.`,
    fields: [{ name: 'draftId', label: 'Import', type: 'hidden' }],
  },
  stamp: 'IMPORT APPLIED',
  describe: (a) => [String(a.title), `${a.changes} changes made${a.leftOut ? `, ${a.leftOut} rows left out` : ''}`, `Can be undone until ${dateText(new Date(String(a.undoUntil)))}`],
  preview: async (ctx, input) => {
    if (typeof input.draftId !== 'string' || !input.draftId) return { info: [], values: {} };
    try {
      const row = await own(ctx.db, ctx.session, input.draftId);
      const plan = row.plan as unknown as StoredPlan;
      if (row.status !== 'DRAFT') return { info: [`${row.title}: ${STATUS_TEXT[row.status].toLowerCase()}.`], values: { draftId: row.id } };
      const info = [row.title, ...plan.lines];
      if (plan.questions.length) info.push(`${plan.questions.length} question${plan.questions.length === 1 ? ' is' : 's are'} still waiting for your answer: answer them first.`);
      return { info, values: { draftId: row.id } };
    } catch (e) { return { info: [e instanceof ToolError ? e.message : 'Which import?'], values: {} }; }
  },
  handler: async (ctx, input) => {
    const row = await own(ctx.db, ctx.session, input.draftId);
    if (row.status !== 'DRAFT') throw new ToolError('NOT_A_DRAFT', row.status === 'APPLIED' ? 'That import was already applied.' : 'That import is not open any more.', undefined, 'draftId');
    const stored = row.plan as unknown as StoredPlan;
    if (stored.questions.length) throw new ToolError('QUESTIONS_OPEN', `${stored.questions.length} question${stored.questions.length === 1 ? ' is' : 's are'} still waiting for your answer, so nothing was changed.`, undefined, 'draftId');
    // the plan is worked out again against the system as it is now: what runs is exactly what was shown, or nothing runs
    const { plan } = await planFor(ctx.session, row.spec as unknown as Spec, row.answers as never, ctx.db);
    if (plan.hash !== stored.hash) {
      await ctx.db.importDraft.update({ where: { id: row.id }, data: { plan: plan as never, revision: { increment: 1 } } });
      throw new ToolError('PLAN_CHANGED', 'Something in the system changed since this was worked out, so I made the plan again. Please look at it once more before applying.', undefined, 'draftId');
    }
    if (plan.steps.length === 0) throw new ToolError('NOTHING_TO_DO', 'There is nothing to change.', undefined, 'draftId');
    const claimed = await ctx.db.importDraft.updateMany({ where: { id: row.id, status: 'DRAFT', revision: row.revision }, data: { status: 'APPLIED', appliedAt: ctx.now, result: { startedAt: ctx.now.toISOString(), finished: false, steps: [] } as never } });
    if (claimed.count !== 1) throw new ToolError('NOT_A_DRAFT', 'That import was already applied.', undefined, 'draftId');
    const steps: Step[] = plan.steps;
    const who = ctx.session;
    return {
      data: { id: row.id, title: row.title, changes: steps.length },
      audit: { entityType: 'ImportDraft', entityId: row.id, action: 'APPLY', after: { title: row.title, changes: steps.length, leftOut: plan.held.length, undoUntil: canUndoUntil(ctx.now)!.toISOString(), files: row.uploadIds.length, counts: Object.fromEntries(['create_material', 'update_material', 'create_party', 'update_party', 'create_part', 'update_part', 'set_part_bom', 'set_opening_quantities'].map((t) => [t, steps.filter((s) => s.tool === t).length]).filter(([, n]) => n)) } },
      afterCommit: async () => {
        const save = async (done: StepResult[], finished: boolean) => { await db.importDraft.update({ where: { id: row.id }, data: { result: { startedAt: ctx.now.toISOString(), finished, steps: done } as never } }); };
        try {
          const results = await executeSteps(who, steps, { now: ctx.now, onProgress: (d) => save(d, false) });
          await save(results, true);
        } catch (e) {
          console.error('[import] apply stopped:', e instanceof Error ? e.message : e);
          throw new Error('The import stopped part-way. What was done so far is kept; ask for the import to see it.');
        }
      },
    };
  },
  followUps: async (ctx, input) => {
    const r = await ctx.read('get_import_draft', { draftId: input.draftId });
    if (!r.ok) return { facts: [], chips: [] };
    const res = (r.data as { result?: { done: number; skipped: number; failed: number } }).result;
    const facts = res ? [`Done: ${res.done}. Not done: ${res.skipped}. Failed: ${res.failed}.`] : [];
    return { facts, cards: draftCards(r.data as Parameters<typeof draftCards>[0]), chips: [{ label: 'What was not done?', ask: 'Which parts of that import were not done, and why?' }, { label: 'Undo this import', form: 'undo_import', prefill: { draftId: String(input.draftId) } }] };
  },
});

// ── undo_import ────────────────────────────────────────────────────────────────────────────────────
export const undoImport = defineTool({
  name: 'undo_import', kind: 'write', roles: ['OWNER'],
  input: z.object({ draftId }),
  form: {
    title: 'Undo an import', verb: 'Undo it',
    intro: 'Puts back what can honestly be put back. What was added is marked as no longer in use (kept in the history); a change is put back only if nobody has changed it since. What cannot be undone is listed afterwards.',
    fields: [{ name: 'draftId', label: 'Import', type: 'hidden' }],
  },
  stamp: 'IMPORT UNDONE',
  describe: (a) => [String(a.title), 'Undone as far as it can be. Ask for the import to see what stayed.'],
  preview: async (ctx, input) => {
    if (typeof input.draftId !== 'string' || !input.draftId) return { info: [], values: {} };
    try {
      const row = await own(ctx.db, ctx.session, input.draftId);
      const until = canUndoUntil(row.appliedAt);
      return { info: [row.title, row.status === 'APPLIED' && until ? `Can be undone until ${dateText(until)}.` : `This import is ${STATUS_TEXT[row.status].toLowerCase()}, so it cannot be undone.`], values: { draftId: row.id } };
    } catch (e) { return { info: [e instanceof ToolError ? e.message : 'Which import?'], values: {} }; }
  },
  handler: async (ctx, input) => {
    const row = await own(ctx.db, ctx.session, input.draftId);
    if (row.status !== 'APPLIED') throw new ToolError('NOT_APPLIED', row.status === 'UNDONE' ? 'That import was already undone.' : 'Only an import that was applied can be undone.', undefined, 'draftId');
    const until = canUndoUntil(row.appliedAt);
    if (!until || until.getTime() <= ctx.now.getTime()) throw new ToolError('TOO_LATE', `An import can only be undone for ${UNDO_DAYS} days after it was applied, and that time is over.`, undefined, 'draftId');
    const result = row.result as unknown as RunResult | null;
    if (!result || !result.finished) throw new ToolError('NOT_FINISHED', 'That import has not finished, so it cannot be undone yet.', undefined, 'draftId');
    const claimed = await ctx.db.importDraft.updateMany({ where: { id: row.id, status: 'APPLIED' }, data: { status: 'UNDONE', undoneAt: ctx.now } });
    if (claimed.count !== 1) throw new ToolError('NOT_APPLIED', 'That import was already undone.', undefined, 'draftId');
    const steps = (row.plan as unknown as StoredPlan).steps;
    const who = ctx.session;
    return {
      data: { id: row.id, title: row.title },
      audit: { entityType: 'ImportDraft', entityId: row.id, action: 'UNDO', after: { title: row.title } },
      afterCommit: async () => {
        const undone = await undoSteps(who, steps, result.steps);
        await db.importDraft.update({ where: { id: row.id }, data: { result: { ...result, undo: { startedAt: ctx.now.toISOString(), finished: true, steps: undone } } as never } });
      },
    };
  },
  followUps: async (ctx, input) => {
    const r = await ctx.read('get_import_draft', { draftId: input.draftId });
    const u = r.ok ? (r.data as { result?: { undone?: { done: number; skipped: number; failed: number } } }).result?.undone : undefined;
    return { facts: u ? [`Undone: ${u.done}. Left as they were: ${u.skipped + u.failed}.`] : [], cards: r.ok ? draftCards(r.data as Parameters<typeof draftCards>[0]) : [], chips: [{ label: 'What stayed?', ask: 'What could not be undone from that import, and why?' }] };
  },
});

export { cardsOf };
