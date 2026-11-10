'use server';

import { z } from 'zod';
import { ARTIFACT_OPENABLE_FORMS, readToolsFor } from '@/lib/catalog';
import { canShare, canShareDoc, checkPrintRequest } from '@/lib/artifacts/check';
import VDoc from '@/lib/artifacts/host/vdoc.cjs';
import type { ChatItem } from '@/lib/cards';
import { currentUser } from '../auth/session';
import { db } from '../db';
import { mapError } from '../errors';
import { allowMessage } from '../chat/rate-limit';
import { ensureConversation } from '../chat/conversation';
import { conversations, pendingActions, registry, runTool } from '../tools';
import type { ToolSession } from '../tools/types';
import { printInput } from './app-tools';
import { FORMATS_BY_KIND, type Format } from './export';
import { renderPrintout } from './printouts';
import * as store from './store';

/** Everything the panel asks of the server. Who is asking comes from the session; nothing in a request can widen a role. */
const LOGGED_OUT = { ok: false as const, code: 'LOGGED_OUT', message: 'Please log in again.' };
const uuid = z.string().uuid();
type Fail = { ok: false; code: string; message: string };

async function who(): Promise<ToolSession | null> {
  const u = await currentUser();
  return u ? { userId: u.id, name: u.name, role: u.role } : null;
}
const fail = (e: unknown): Fail => { const m = mapError(e); return { ok: false, code: m.code, message: m.message }; };

export interface FormatChoice { format: Format; label: string; ok: boolean; why?: string }
const LABEL: Record<Format, string> = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel', csv: 'CSV', png: 'Picture', md: 'Markdown' };

export interface LoadedArtifact {
  id: string; title: string; kind: store.Kind; version: number; source: string; saved: boolean; owned: boolean; sharedBy: string | null; sharedAt: string | null;
  sharedWithStorekeeper: boolean; canShare: { ok: boolean; reason?: string }; formats: FormatChoice[];
  versions: { n: number; request: string; summary: string | null; restored: boolean; at: string }[];
}

/** An artifact for the panel. Re-checks the source for THIS person's role at open time (an old or shared one may not pass any more). */
export async function loadArtifactAction(input: { id: string }): Promise<{ ok: true; artifact: LoadedArtifact } | Fail> {
  const me = await who();
  if (!me) return LOGGED_OUT;
  const p = uuid.safeParse(input.id);
  if (!p.success) return { ok: false, code: 'NOT_FOUND', message: "Couldn't find that artifact." };
  try {
    const a = await store.accessFor(db, me, p.data);
    const hasTable = a.kind === 'page' || ((VDoc.parse(a.source).blocks ?? []) as { type: string }[]).some((b) => b.type === 'vtable' || b.type === 'table');
    const formats: FormatChoice[] = FORMATS_BY_KIND[a.kind].map((f) => ({ format: f, label: LABEL[f], ok: !((f === 'xlsx' || f === 'csv') && !hasTable), ...((f === 'xlsx' || f === 'csv') && !hasTable ? { why: 'there is no table in this' } : {}) }));
    return {
      ok: true,
      artifact: {
        id: a.artifactId, title: a.title, kind: a.kind, version: a.version, source: a.source, saved: a.saved, owned: a.owned, sharedBy: a.sharedBy, sharedAt: a.sharedAt, sharedWithStorekeeper: a.sharedWithStorekeeper,
        canShare: a.owned && me.role === 'OWNER' ? (a.kind === 'document' ? canShareDoc(a.source) : canShare(a.source)) : { ok: false }, formats,
        versions: a.owned ? await store.versionsOf(db, me, a.artifactId) : [],
      },
    };
  } catch (e) { return fail(e); }
}

/**
 * A read the artifact asked for, answered as the viewer. The host already filtered; this is the authority: the tool must be
 * a read tool this role may use, and runTool checks the role again. A rate limit per person stands behind the host's.
 */
export async function artifactReadAction(input: { artifactId: string; tool: string; input: unknown }): Promise<{ ok: true; data: unknown } | Fail> {
  const me = await who();
  if (!me) return LOGGED_OUT;
  const p = z.object({ artifactId: uuid, tool: z.string().min(1).max(60), input: z.unknown() }).safeParse(input);
  if (!p.success) return { ok: false, code: 'INVALID_INPUT', message: "Couldn't load that. Try again." };
  if (!allowMessage(`read:${me.userId}`, 240)) return { ok: false, code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' };
  try { await store.accessFor(db, me, p.data.artifactId); } catch (e) { return fail(e); }
  const t = registry.get(p.data.tool);
  if (!t || t.kind !== 'read' || !readToolsFor(me.role).includes(p.data.tool)) return { ok: false, code: 'NOT_AVAILABLE', message: "This isn't available to you." };
  const out = await runTool(me, p.data.tool, p.data.input ?? {});
  return out.ok ? { ok: true, data: out.data } : { ok: false, code: out.code, message: out.message };
}

export type ArtifactFormResult = { ok: true; conversationId: string; created: boolean; items: ChatItem[] } | Fail;

/** A row button or openForm inside an artifact: opens the tool's own form in the chat. Never saves. Rates are dropped (sanitizePrefill). */
export async function openArtifactFormAction(input: { artifactId: string; tool: string; prefill?: Record<string, unknown>; conversationId?: string | null }): Promise<ArtifactFormResult> {
  const me = await who();
  if (!me) return LOGGED_OUT;
  const p = z.object({ artifactId: uuid, tool: z.string().min(1).max(60), prefill: z.record(z.unknown()).optional(), conversationId: uuid.nullish() }).safeParse(input);
  if (!p.success) return { ok: false, code: 'INVALID_INPUT', message: "Couldn't open that form." };
  if (!ARTIFACT_OPENABLE_FORMS.has(p.data.tool)) return { ok: false, code: 'NOT_AVAILABLE', message: "This isn't available to you." };
  try {
    const a = await store.accessFor(db, me, p.data.artifactId);
    const conv = await ensureConversation(me, p.data.conversationId);
    if (!conv) return { ok: false, code: 'NOT_FOUND', message: "Couldn't find that chat." };
    const opened = await pendingActions.create(me, { tool: p.data.tool, origin: 'ARTIFACT', conversationId: conv.id, input: p.data.prefill, artifactId: a.artifactId, artifactVersion: a.version });
    if (!opened.ok) return opened;
    const card = await pendingActions.formCard(me, opened.data);
    const row = await conversations.append(conv.id, 'CARD', { kind: 'card', card });
    const items: ChatItem[] = [];
    if (conv.created) for (const r of (await conversations.items(me.userId, conv.id)) ?? []) if (r.id !== row.id) items.push(r);
    items.push({ id: row.id, role: 'card', card, state: 'open' });
    return { ok: true, conversationId: conv.id, created: conv.created, items };
  } catch (e) { return fail(e); }
}

export async function listArtifactsAction(input: { query?: string } = {}): Promise<{ ok: true; mine: store.ArtifactRow[]; shared: store.ArtifactRow[] } | Fail> {
  const me = await who();
  if (!me) return LOGGED_OUT;
  const r = await store.listFor(db, me, z.string().max(100).optional().parse(input.query));
  return { ok: true, ...r };
}

export async function saveArtifactAction(input: { id: string; saved: boolean }): Promise<{ ok: true; saved: boolean } | Fail> {
  const me = await who();
  if (!me) return LOGGED_OUT;
  const p = z.object({ id: uuid, saved: z.boolean() }).safeParse(input);
  if (!p.success) return { ok: false, code: 'INVALID_INPUT', message: 'Something went wrong. Please try again.' };
  try {
    await store.setSaved(db, me, p.data.id, p.data.saved);
    await store.auditArtifact(db, { who: me, entityId: p.data.id, action: p.data.saved ? 'SAVE' : 'UNSAVE' });
    return { ok: true, saved: p.data.saved };
  } catch (e) { return fail(e); }
}

export async function archiveArtifactAction(input: { id: string }): Promise<{ ok: true } | Fail> {
  const me = await who();
  if (!me) return LOGGED_OUT;
  const p = uuid.safeParse(input.id);
  if (!p.success) return { ok: false, code: 'INVALID_INPUT', message: 'Something went wrong. Please try again.' };
  try { await store.archive(db, me, p.data); await store.auditArtifact(db, { who: me, entityId: p.data, action: 'ARCHIVE' }); return { ok: true }; } catch (e) { return fail(e); }
}

export async function restoreVersionAction(input: { id: string; n: number }): Promise<{ ok: true; version: number } | Fail> {
  const me = await who();
  if (!me) return LOGGED_OUT;
  const p = z.object({ id: uuid, n: z.number().int().min(1).max(1000) }).safeParse(input);
  if (!p.success) return { ok: false, code: 'INVALID_INPUT', message: 'Something went wrong. Please try again.' };
  try {
    const r = await store.restore(db, me, p.data.id, p.data.n);
    await store.auditArtifact(db, { who: me, entityId: p.data.id, action: 'RESTORE', after: { from: p.data.n, version: r.version } });
    return { ok: true, version: r.version };
  } catch (e) { return fail(e); }
}

export interface LoadedPrintout { title: string; html: string; href: string; filename: string }

/** A printout for the panel: its HTML (shown in a frame that cannot run script) and where its PDF is. */
export async function loadPrintoutAction(input: { template: string; ref: Record<string, string> }): Promise<{ ok: true; printout: LoadedPrintout } | Fail> {
  const me = await who();
  if (!me) return LOGGED_OUT;
  const p = z.object({ template: z.string().max(40), ref: z.record(z.string().max(80)) }).safeParse(input);
  if (!p.success) return { ok: false, code: 'INVALID_INPUT', message: "Couldn't open that printout." };
  const allowed = checkPrintRequest(p.data.template, me.role);
  if (!allowed.ok) return { ok: false, code: 'FORBIDDEN_ROLE', message: allowed.message ?? 'That printout is not available to you.' };
  const out = await runTool(me, 'get_print_data', printInput(p.data.template, p.data.ref));
  if (!out.ok) return { ok: false, code: out.code, message: out.message };
  const r = renderPrintout(out.data);
  const q = new URLSearchParams(p.data.ref);
  return { ok: true, printout: { title: r.title, html: r.html, filename: r.filename, href: `/api/printouts/${p.data.template}?${q.toString()}` } };
}
