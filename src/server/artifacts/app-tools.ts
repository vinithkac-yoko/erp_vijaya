import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { PRINT_TEMPLATES, readToolsFor, TOOLS, type Role } from '@/lib/catalog';
import { canShare, canShareDoc, checkPrintRequest } from '@/lib/artifacts/check';
import { ARTIFACT_ASKED } from '@/lib/artifacts/asked';
import VDoc from '@/lib/artifacts/host/vdoc.cjs';
import type { Card } from '@/lib/cards';
import descriptions from '../../../prompts/tool-descriptions.json';
import { mapError } from '../errors';
import type { createRunTool } from '../tools/run-tool';
import type { ToolSession } from '../tools/types';
import { BuilderError, buildEdit, buildNew, type BuilderModel } from './builder';
import { FORMATS_BY_KIND, type Format } from './export';
import { accessFor, addVersion, auditArtifact, BUILDS_PER_HOUR, buildsLastHour, createArtifact, listFor, type Kind } from './store';
import { db } from '../db';

/**
 * The assistant's artifact tools (docs/TOOL_CATALOG.md §A): not business data, so they are not in the registry. They store
 * and open artifacts; the artifact itself reads business data only through the Tool Gateway, as whoever is looking.
 * Every one is offered to both roles and checked again here.
 */
export interface AppToolContext {
  session: ToolSession;
  conversationId: string;
  runId: string;
  /** What the person typed lately (newest last): the guard behind "never an artifact nobody asked for". */
  userTexts: string[];
  /** The artifact open beside the chat, if any: the default for edit_artifact and download_data. */
  openArtifactId?: string;
  builder: BuilderModel | null;
  runTool: ReturnType<typeof createRunTool>;
  now: Date;
}
export interface AppToolResult { text: string; isError?: boolean; cards?: Card[]; usage?: { input: number; output: number } }
interface AppTool { roles: Role[]; input: z.ZodTypeAny; run: (ctx: AppToolContext, input: never) => Promise<AppToolResult> }

const TEXT = (descriptions as { tools: Record<string, { description: string; inputs: Record<string, string> }> }).tools;
const ok = (o: unknown, extra: Partial<AppToolResult> = {}): AppToolResult => ({ text: JSON.stringify(o), ...extra });
const fail = (message: string): AppToolResult => ({ text: JSON.stringify({ error: message }), isError: true });
const optId = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().max(64).optional());
const FORMAT_WORDS: Record<Format, string> = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel', csv: 'CSV', png: 'a picture', md: 'Markdown' };

const artifactCard = (a: { artifactId: string; title: string; version: number; kind: Kind }, open = true): Card => ({ kind: 'artifact', artifactId: a.artifactId, title: a.title, version: a.version, artifactKind: a.kind, open });

// ── list_artifacts ─────────────────────────────────────────────────────────────────────────────────
const listArtifacts: AppTool = {
  roles: ['STOREKEEPER', 'OWNER'], input: z.object({ query: z.string().max(100).optional() }),
  run: async (ctx, input: { query?: string }) => {
    const r = await listFor(db, ctx.session, input.query);
    // The owner is told up front which ones cannot be shared (and why), so the assistant never opens a share form that is bound to be refused.
    const sources = ctx.session.role === 'OWNER' ? new Map((await db.artifact.findMany({ where: { id: { in: r.mine.slice(0, 15).map((a) => a.artifactId) } }, select: { id: true, currentVersion: { select: { source: true } } } })).map((a) => [a.id, a.currentVersion?.source ?? ''])) : new Map<string, string>();
    const sharing = (a: { artifactId: string; kind: Kind }) => {
      if (ctx.session.role !== 'OWNER') return undefined;
      const src = sources.get(a.artifactId) ?? '';
      const c = a.kind === 'document' ? canShareDoc(src) : canShare(src);
      return c.ok ? 'can be shared' : `cannot be shared: ${c.reason}`;
    };
    return ok({ mine: r.mine.slice(0, 15).map((a) => ({ artifactId: a.artifactId, title: a.title, kind: a.kind, version: a.version, saved: a.saved, updatedAt: a.updatedAt, sharing: sharing(a) })), sharedWithMe: r.shared.slice(0, 15).map(({ artifactId, title, kind, version, sharedBy }) => ({ artifactId, title, kind, version, sharedBy })) });
  },
};

// ── open_artifact ──────────────────────────────────────────────────────────────────────────────────
const openArtifact: AppTool = {
  roles: ['STOREKEEPER', 'OWNER'], input: z.object({ artifactId: z.string().min(1).max(64) }),
  run: async (ctx, input: { artifactId: string }) => {
    try {
      const a = await accessFor(db, ctx.session, input.artifactId);
      return ok({ opened: a.title, version: a.version, kind: a.kind }, { cards: [artifactCard(a)] });
    } catch (e) { return fail(mapError(e).message); }
  },
};

// ── make_artifact ──────────────────────────────────────────────────────────────────────────────────
const makeArtifact: AppTool = {
  roles: ['STOREKEEPER', 'OWNER'], input: z.object({ request: z.string().min(3, 'Say what it is for.').max(1500), kind: z.enum(['document', 'page']).optional() }),
  run: async (ctx, input: { request: string; kind?: Kind }) => {
    if (!ctx.builder) return fail("I can't build one right now. The buttons above still work.");
    // The person must have asked for something that is an artifact. A fact is a sentence, a short list is a table, a change is a form.
    if (!ctx.userTexts.slice(-2).some((t) => ARTIFACT_ASKED.test(t))) {
      return fail('Nobody asked for a report, chart, document or what-if. Answer in a sentence or an inline table instead, and offer an artifact in one line.');
    }
    if ((await buildsLastHour(db, ctx.session.userId, ctx.now)) >= BUILDS_PER_HOUR) return fail(`That is ${BUILDS_PER_HOUR} made in the last hour, which is the most. Try again a little later.`);
    try {
      const built = await buildNew(ctx.builder, { role: ctx.session.role, kind: input.kind, request: input.request });
      const made = await createArtifact(db, { ownerId: ctx.session.userId, conversationId: ctx.conversationId, kind: built.kind, title: built.title, source: built.source, request: input.request, summary: built.summary, checkReport: JSON.parse(JSON.stringify(built.report)) });
      await auditArtifact(db, { who: ctx.session, entityId: made.artifactId, action: 'CREATE', toolName: 'make_artifact', openedFrom: 'AGENT', agentRunId: ctx.runId, after: { title: built.title, kind: built.kind, version: 1, reads: built.report.reads } });
      return ok(
        { title: built.title, kind: built.kind, version: 1, reads: built.report.reads, note: 'It is open beside the chat. Say what it is in one sentence and offer to save it. Do not list its numbers.' },
        { cards: [artifactCard({ artifactId: made.artifactId, title: built.title, version: 1, kind: built.kind })], usage: built.usage },
      );
    } catch (e) {
      if (e instanceof BuilderError) return fail(`I couldn't build that. ${e.issues[0]?.message ?? ''} Tell the user in one plain sentence what could not be included, and show the nearest table in the chat instead.`.trim());
      return fail(mapError(e).message);
    }
  },
};

// ── edit_artifact ──────────────────────────────────────────────────────────────────────────────────
const editArtifact: AppTool = {
  roles: ['STOREKEEPER', 'OWNER'], input: z.object({ artifactId: optId, request: z.string().min(3, 'Say what to change.').max(1500) }),
  run: async (ctx, input: { artifactId?: string; request: string }) => {
    if (!ctx.builder) return fail("I can't change it right now.");
    const id = input.artifactId ?? ctx.openArtifactId;
    if (!id) return fail('Which artifact? Open it first, or say which one.');
    try {
      const a = await accessFor(db, ctx.session, id);
      if (!a.owned) return fail("That one was shared with this person, so it can't be changed. Offer to make their own copy with make_artifact.");
      if ((await buildsLastHour(db, ctx.session.userId, ctx.now)) >= BUILDS_PER_HOUR) return fail(`That is ${BUILDS_PER_HOUR} made in the last hour, which is the most. Try again a little later.`);
      const built = await buildEdit(ctx.builder, { role: ctx.session.role, kind: a.kind, current: a.source, request: input.request });
      const v = await addVersion(db, a.artifactId, { source: built.source, request: input.request, summary: built.summary, madeBy: 'AGENT', checkReport: JSON.parse(JSON.stringify(built.report)), title: built.title || undefined });
      await auditArtifact(db, { who: ctx.session, entityId: a.artifactId, action: 'EDIT', toolName: 'edit_artifact', openedFrom: 'AGENT', agentRunId: ctx.runId, after: { title: built.title || a.title, version: v.version, summary: built.summary } });
      return ok({ title: built.title || a.title, version: v.version, changed: built.summary }, { cards: [artifactCard({ artifactId: a.artifactId, title: built.title || a.title, version: v.version, kind: a.kind })], usage: built.usage });
    } catch (e) {
      if (e instanceof BuilderError) return fail(`I couldn't make that change. ${e.issues[0]?.message ?? ''} Tell the user in one plain sentence; the artifact is unchanged.`.trim());
      return fail(mapError(e).message);
    }
  },
};

// ── open_printout ──────────────────────────────────────────────────────────────────────────────────
const WITH_KEYS: Record<string, { key: string; field: string }> = {
  'purchase-order': { key: 'purchaseOrder', field: 'purchaseOrderId' }, 'goods-receipt-note': { key: 'receipt', field: 'receiptId' },
  'issue-slip': { key: 'job', field: 'jobId' }, 'count-sheet': { key: 'count', field: 'countId' }, 'job-cost-sheet': { key: 'job', field: 'jobId' },
};
export const printInput = (template: string, ref: Record<string, unknown>) => {
  const w = WITH_KEYS[template];
  const v = w ? ref[w.key] : undefined;
  return w ? { template, ...(typeof v === 'string' && v ? { [w.field]: v } : {}) } : { template };
};
const openPrintout: AppTool = {
  roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ template: z.string().max(40), with: z.record(z.union([z.string(), z.number()]).transform(String)).optional() }),
  run: async (ctx, input: { template: string; with?: Record<string, string> }) => {
    const allowed = checkPrintRequest(input.template, ctx.session.role);
    if (!allowed.ok) return fail(allowed.message ?? 'That printout is not available to you.');
    const w = WITH_KEYS[input.template]!;
    const ref = input.with ?? {};
    const out = await ctx.runTool(ctx.session, 'get_print_data', printInput(input.template, ref));
    if (!out.ok) return fail(out.message);
    const data = out.data as { po?: { number: string; approved: boolean }; grn?: { number: string }; job?: { number: string }; count?: { number: string } };
    const label = data.po?.number ?? data.grn?.number ?? data.job?.number ?? data.count?.number ?? '';
    const title = `${PRINT_TEMPLATES[input.template]!.title.replace(/ \(.*\)$/, '')} · ${label}`;
    const note = input.template === 'purchase-order' && data.po && !data.po.approved ? 'It prints with a "NOT APPROVED" mark until the owner approves it.' : undefined;
    return ok({ opened: title, ...(note ? { note } : {}) }, { cards: [{ kind: 'printout', template: input.template, title, ref: { [w.key]: label }, open: true }] });
  },
};

// ── download_data ──────────────────────────────────────────────────────────────────────────────────
const FORMATS = ['pdf', 'docx', 'xlsx', 'csv', 'png', 'md'] as const;
const downloadData: AppTool = {
  roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ format: z.enum(FORMATS), source: z.object({ tool: z.string().max(60), input: z.record(z.unknown()).optional() }).optional(), artifactId: optId, title: z.string().max(80).optional() }),
  run: async (ctx, input: { format: Format; source?: { tool: string; input?: Record<string, unknown> }; artifactId?: string; title?: string }) => {
    if (input.source) {
      if (input.format !== 'xlsx' && input.format !== 'csv') return fail(`A table can be downloaded as Excel or CSV, not ${FORMAT_WORDS[input.format]}. Offer Excel.`);
      const meta = TOOLS[input.source.tool];
      if (!meta || !readToolsFor(ctx.session.role).includes(input.source.tool)) return fail("That isn't something this person can download.");
      const q = new URLSearchParams({ tool: input.source.tool, input: JSON.stringify(input.source.input ?? {}), format: input.format, ...(input.title ? { title: input.title } : {}) });
      return ok({ ready: `${FORMAT_WORDS[input.format]} file`, note: 'A download button is in the chat. The file is made when they tap it, from the numbers at that moment. It cannot be emailed from here.' },
        { cards: [{ kind: 'download', label: `Download ${FORMAT_WORDS[input.format]} · ${input.title ?? meta.name.replace(/_/g, ' ')}`, href: `/api/download?${q.toString()}` }] });
    }
    const id = input.artifactId ?? ctx.openArtifactId;
    if (!id) return fail('Which one? Open it first, or say which table or artifact.');
    try {
      const a = await accessFor(db, ctx.session, id);
      if (!FORMATS_BY_KIND[a.kind].includes(input.format)) {
        return fail(`A ${a.kind} can't be downloaded as ${FORMAT_WORDS[input.format]}. It can be ${FORMATS_BY_KIND[a.kind].map((f) => FORMAT_WORDS[f]).join(', ')}. Offer one of those.`);
      }
      if ((input.format === 'xlsx' || input.format === 'csv') && a.kind === 'document') {
        const blocks = (VDoc.parse(a.source).blocks ?? []) as { type: string }[];
        if (!blocks.some((b) => b.type === 'vtable' || b.type === 'table')) return fail('There is no table in this document to put in a spreadsheet. Offer PDF or Word.');
      }
      return ok({ ready: `${FORMAT_WORDS[input.format]} of ${a.title}`, note: 'A download button is in the chat. The file is made when they tap it, with their own role.' },
        { cards: [{ kind: 'download', label: `Download ${FORMAT_WORDS[input.format]} · ${a.title}`, href: `/api/artifacts/${a.artifactId}/download?format=${input.format}` }] });
    } catch (e) { return fail(mapError(e).message); }
  },
};

export const APP_TOOLS: Record<string, AppTool> = {
  list_artifacts: listArtifacts, open_artifact: openArtifact, make_artifact: makeArtifact, edit_artifact: editArtifact, open_printout: openPrintout, download_data: downloadData,
};

/** What the model sees for these tools (the words come from prompts/tool-descriptions.json, like every other tool). */
export function appToolDefs(role: Role): Anthropic.Tool[] {
  return Object.entries(APP_TOOLS).filter(([, t]) => t.roles.includes(role)).map(([name, t]) => {
    const text = TEXT[name];
    const raw = zodToJsonSchema(t.input, { target: 'jsonSchema7', $refStrategy: 'none', effectStrategy: 'input' }) as Record<string, unknown>;
    delete raw.$schema;
    const props = { ...((raw.properties as Record<string, Record<string, unknown>>) ?? {}) };
    for (const [k, p] of Object.entries(props)) { const d = text?.inputs[k]; if (d) props[k] = { ...p, description: d }; }
    return { name, description: text?.description ?? name, input_schema: { type: 'object', properties: props, ...(Array.isArray(raw.required) && raw.required.length ? { required: raw.required } : {}) } as Anthropic.Tool.InputSchema };
  });
}

export async function runAppTool(name: string, ctx: AppToolContext, rawInput: unknown): Promise<AppToolResult> {
  const tool = APP_TOOLS[name];
  if (!tool || !tool.roles.includes(ctx.session.role)) return fail("I can't do that.");
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Something in that was not right.');
  try { return await tool.run(ctx, parsed.data as never); } catch (e) { return fail(mapError(e).message); }
}
