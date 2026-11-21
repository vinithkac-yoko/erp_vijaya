import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { materialNameKey } from '@/lib/names';
import type { Card } from '@/lib/cards';
import { db } from '../../db';
import type { Db, ToolSession } from '../types';
import { ownerOnly, getUpload } from './store';
import { UploadError } from './files';
import { gridFor, planImport, specProblems } from './plan';
import { Spec, type Answer, type Answers, type Grid, type Plan, type Snapshot } from './types';

/**
 * Import drafts (milestone 16): a proposal the owner can look at, answer questions about, and apply. A draft keeps what the
 * assistant said each table is (the spec), the owner's answers, and the plan worked out from those and from the database as it
 * is when the plan is made. Nothing here changes business data: that happens only when the owner presses Apply.
 */
export const UNDO_DAYS = 7;
const DAY = 86_400_000;

export interface StoredPlan extends Plan { hash: string }

export async function snapshot(client: Db = db): Promise<Snapshot> {
  const [materials, parties, parts, count] = await Promise.all([
    client.material.findMany({ select: { id: true, name: true, nameKey: true, itemCode: true, itemCodeKey: true, uom: true, category: true, rack: true, shelf: true, minimumLevel: true, stockType: true, hsnCode: true, gstRate: true, isActive: true } }),
    client.party.findMany({ select: { id: true, name: true, nameKey: true, gstin: true, city: true, state: true, addressLine: true, pincode: true, phone: true, email: true, isSupplier: true, isCustomer: true, isActive: true } }),
    client.part.findMany({ select: { id: true, customerId: true, partNumber: true, partKey: true, description: true, hsnCode: true, isActive: true, customer: { select: { name: true } }, bomLines: { select: { materialId: true, qtyPerPiece: true, material: { select: { name: true } } } } } }),
    client.stockCount.findFirst({ where: { isOpening: true }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, number: true, lines: { select: { countedQty: true, material: { select: { name: true } } } } } }),
  ]);
  return {
    materials: materials.map((m) => ({ ...m, uom: m.uom as string, stockType: m.stockType as string, minimumLevel: m.minimumLevel === null ? null : Number(m.minimumLevel), gstRate: m.gstRate === null ? null : Number(m.gstRate) })),
    parties,
    parts: parts.map((p) => ({ id: p.id, customerId: p.customerId, customerName: p.customer.name, partNumber: p.partNumber, partKey: p.partKey, description: p.description, hsnCode: p.hsnCode, isActive: p.isActive, bom: p.bomLines.map((b) => ({ materialId: b.materialId, materialName: b.material.name, qtyPerPiece: Number(b.qtyPerPiece) })) })),
    count: count ? { id: count.id, status: count.status, number: count.number, lines: new Map(count.lines.map((l) => [materialNameKey(l.material.name), { countedQty: l.countedQty === null ? null : Number(l.countedQty) }])) } : null,
  };
}

const hashOf = (p: Plan) => createHash('sha256').update(JSON.stringify(p.steps.map((s) => [s.key, s.tool, s.input]))).digest('hex').slice(0, 24);

/** Reads the tables the spec names out of the owner's uploads and plans them. Throws UploadError with the problems in plain words. */
export async function planFor(session: ToolSession, spec: Spec, answers: Answers, client: Db = db): Promise<{ plan: StoredPlan; grids: Grid[] }> {
  const grids: (Grid | string)[] = [];
  const cache = new Map<string, Awaited<ReturnType<typeof getUpload>>>();
  for (const t of spec.tables) {
    try {
      const u = cache.get(t.uploadId) ?? (cache.set(t.uploadId, await getUpload(session, t.uploadId)), cache.get(t.uploadId)!);
      grids.push(gridFor(u.content, t, u.row.filename));
    } catch (e) { grids.push(e instanceof UploadError ? e.message : "I can't read that file."); }
  }
  const problems = specProblems(spec, grids);
  if (problems.length) throw new UploadError(problems.join('\n'));
  const plan = planImport(spec, grids as Grid[], await snapshot(client), answers);
  return { plan: { ...plan, hash: hashOf(plan) }, grids: grids as Grid[] };
}

const json = (v: unknown) => v as unknown as Prisma.InputJsonValue;

export async function createDraft(session: ToolSession, input: { conversationId?: string | null; spec: Spec; answers?: Answers }) {
  ownerOnly(session);
  const answers = input.answers ?? {};
  const { plan } = await planFor(session, input.spec, answers);
  const row = await db.importDraft.create({ data: { userId: session.userId, conversationId: input.conversationId ?? null, title: input.spec.title, spec: json(input.spec), plan: json(plan), answers: json(answers), uploadIds: [...new Set(input.spec.tables.map((t) => t.uploadId))] } });
  return row;
}

export async function getDraft(session: ToolSession, id: string) {
  ownerOnly(session);
  const row = await db.importDraft.findFirst({ where: { id, userId: session.userId } });
  if (!row) throw new UploadError("I can't find that import.");
  return row;
}

export interface Revision { spec?: Spec; answers?: Answers; /** Fill every open question with the suggestion (only when the owner said to go with the suggestions). */ acceptSuggestions?: boolean }

const mergeAnswers = (old: Answers, add: Answers): Answers => {
  const out: Answers = { ...old };
  for (const [k, a] of Object.entries(add)) {
    const prev: Answer | undefined = out[k];
    // a new choice for everything replaces the old one; per-item choices are kept unless the new ones name the same item
    out[k] = { choice: a.choice, ...(a.perItem || prev?.perItem ? { perItem: { ...(a.choice === prev?.choice ? prev?.perItem : {}), ...a.perItem } } : {}) };
  }
  return out;
};

export async function reviseDraft(session: ToolSession, id: string, rev: Revision) {
  const row = await getDraft(session, id);
  if (row.status !== 'DRAFT') throw new UploadError(row.status === 'APPLIED' ? 'That import was already applied. Start a new one for more changes.' : 'That import was discarded.');
  const spec = rev.spec ?? (row.spec as unknown as Spec);
  let answers = mergeAnswers(row.answers as unknown as Answers, rev.answers ?? {});
  let { plan } = await planFor(session, spec, answers);
  if (rev.acceptSuggestions) {
    // the owner said "go with your suggestions": every open question gets its suggested option (a question can open more as answers arrive)
    for (let i = 0; i < 6 && plan.questions.length; i++) {
      answers = mergeAnswers(answers, Object.fromEntries(plan.questions.map((q) => [q.key, { choice: q.suggested }])));
      plan = (await planFor(session, spec, answers)).plan;
    }
  }
  return db.importDraft.update({ where: { id }, data: { spec: json(spec), plan: json(plan), answers: json(answers), uploadIds: [...new Set(spec.tables.map((t) => t.uploadId))], revision: { increment: 1 } } });
}

export async function discardDraft(session: ToolSession, id: string) {
  const row = await getDraft(session, id);
  if (row.status !== 'DRAFT') throw new UploadError('Only an import that has not been applied can be discarded.');
  await db.importDraft.update({ where: { id }, data: { status: 'DISCARDED' } });
}

export const canUndoUntil = (appliedAt: Date | null) => (appliedAt ? new Date(appliedAt.getTime() + UNDO_DAYS * DAY) : null);

/** What the assistant is told about a draft (and what the owner's cards show): in words and counts, no ids except the draft's own. */
export function viewOf(row: { id: string; title: string; status: string; revision: number; plan: unknown; appliedAt?: Date | null }) {
  const plan = row.plan as StoredPlan;
  return {
    draftId: row.id, title: row.title, status: row.status, revision: row.revision,
    canApply: row.status === 'DRAFT' && plan.questions.length === 0 && plan.steps.length > 0,
    willDo: plan.lines,
    openQuestions: plan.questions.map((q) => ({ key: q.key, question: q.text, howMany: q.itemCount, examples: q.examples, items: q.items.slice(0, 15), options: q.options, suggested: q.suggested })),
    leftOut: { count: plan.held.length, first: plan.held.slice(0, 12).map((h) => ({ where: `${h.sheet}, row ${h.row}`, item: h.item, reason: h.reason })) },
    notes: plan.notes.slice(0, 12), moreNotes: Math.max(0, plan.notes.length - 12),
    ...(row.appliedAt ? { appliedAt: row.appliedAt.toISOString(), canUndoUntil: canUndoUntil(row.appliedAt)!.toISOString() } : {}),
  };
}

/** What the screen draws for a draft: tables built from the plan by the server (the assistant only writes the sentence around them). */
export function cardsOf(row: { id: string; title: string; plan: unknown }): Card[] {
  const plan = row.plan as StoredPlan;
  const cards: Card[] = [{ kind: 'table', title: `${row.title}: what will change`, columns: [{ key: 'what', label: 'What' }], rows: plan.lines.map((what) => ({ what })) }];
  if (plan.questions.length) cards.push({ kind: 'table', title: 'Waiting for your answer', columns: [{ key: 'q', label: 'Question' }, { key: 'o', label: 'Choices' }, { key: 'e', label: 'For example' }], rows: plan.questions.map((q) => ({ q: q.text, o: q.options.map((o) => o.label).join(' · '), e: q.examples[0] ?? '–' })) });
  if (plan.held.length) cards.push({ kind: 'table', title: `Left out (${plan.held.length})`, columns: [{ key: 'i', label: 'Row' }, { key: 'r', label: 'Why' }], rows: plan.held.slice(0, 10).map((h) => ({ i: `${h.item} (row ${h.row})`, r: h.reason })), note: plan.held.length > 10 ? `Showing 10 of ${plan.held.length}.` : undefined });
  return cards;
}
