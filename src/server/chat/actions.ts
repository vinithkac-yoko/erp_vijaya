'use server';

import { z } from 'zod';
import type { ChatItem } from '@/lib/cards';
import type { PickerOption } from '@/lib/forms';
import { currentUser } from '../auth/session';
import { conversations, currentCount, pendingActions, registry } from '../tools';
import type { ToolSession } from '../tools/types';
import { ensureConversation } from './conversation';
import { pickerLabel, pickerOptions, type PickerKind } from './pickers';
import { loadSheet, saveSheetRows, type SheetData, type SheetEdit } from './sheet';
import { assistantRuntime } from './runtime';
import { submitAndFollow, type SubmitResult } from './submit';

const LOGGED_OUT: { ok: false; code: string; message: string; field?: string; details?: unknown } = { ok: false, code: 'LOGGED_OUT', message: 'Please log in again.' };
const uuid = z.string().uuid();

async function who(): Promise<ToolSession | null> {
  const u = await currentUser();
  return u ? { userId: u.id, name: u.name, role: u.role } : null;
}

export type OpenFormResult =
  | { ok: true; sheet?: false; conversationId: string; created: boolean; items: ChatItem[] }
  | { ok: true; sheet: true }
  | { ok: false; code: string; message: string };

/** A launcher button: opens the tool's form with nothing filled in. No model is involved, so it works with the assistant off. */
export async function openFormAction(input: { tool: string; conversationId?: string | null; prefill?: Record<string, unknown> }): Promise<OpenFormResult> {
  const session = await who();
  if (!session) return LOGGED_OUT;
  const p = z.object({ tool: z.string().min(1).max(60), conversationId: uuid.nullish(), prefill: z.record(z.unknown()).optional() }).safeParse(input);
  if (!p.success) return { ok: false, code: 'INVALID_INPUT', message: 'Something went wrong. Please try again.' };
  // "Count stock" while a count is open means "carry on counting" (or, once it is with the owner, look at it): the sheet, not a second count.
  if (p.data.tool === 'start_stock_count' && (await currentCount())) return { ok: true, sheet: true };
  const conv = await ensureConversation(session, p.data.conversationId);
  if (!conv) return { ok: false, code: 'NOT_FOUND', message: "Couldn't find that chat." };
  const opened = await pendingActions.create(session, { tool: p.data.tool, origin: 'LAUNCHER', conversationId: conv.id, input: p.data.prefill, fromChip: !!p.data.prefill });
  if (!opened.ok) return opened;
  const card = await pendingActions.formCard(session, opened.data);
  const row = await conversations.append(conv.id, 'CARD', { kind: 'card', card });
  const items: ChatItem[] = [];
  if (conv.created) for (const r of (await conversations.items(session.userId, conv.id)) ?? []) if (r.id !== row.id) items.push(r);
  items.push({ id: row.id, role: 'card', card, state: 'open' });
  return { ok: true, conversationId: conv.id, created: conv.created, items };
}

/** The form's button. The server does the save and draws the "Saved" card; a refusal comes back with the field it belongs to. */
export async function submitFormAction(input: { pendingId: string; values: Record<string, unknown> }): Promise<SubmitResult> {
  const session = await who();
  if (!session) return LOGGED_OUT;
  const p = z.object({ pendingId: uuid, values: z.record(z.unknown()) }).safeParse(input);
  if (!p.success) return { ok: false, code: 'INVALID_INPUT', message: 'Something went wrong. Please try again.' };
  const { agent } = await assistantRuntime();
  return submitAndFollow(session, p.data.pendingId, p.data.values, agent);
}

/** "Not now": closes the form and says plainly that nothing was saved. */
export async function cancelFormAction(input: { pendingId: string; conversationId?: string | null }): Promise<{ ok: boolean; items: ChatItem[] }> {
  const session = await who();
  const p = z.object({ pendingId: uuid, conversationId: uuid.nullish() }).safeParse(input);
  if (!session || !p.success) return { ok: false, items: [] };
  const r = await pendingActions.cancel(session, p.data.pendingId);
  if (!r.ok) return { ok: false, items: [] };
  const card = { kind: 'notice' as const, tone: 'info' as const, text: 'Nothing was saved.' };
  const own = p.data.conversationId && (await conversations.own(session.userId, p.data.conversationId));
  const row = own ? await conversations.append(p.data.conversationId as string, 'CARD', { kind: 'card', card }) : null;
  return { ok: true, items: [{ id: row?.id ?? `n-${Date.now()}`, role: 'card', card }] };
}

/** Type-ahead for the pickers in a form. */
export async function pickerAction(input: { kind: PickerKind; query: string; role?: 'SUPPLIER' | 'CUSTOMER'; forId?: string; filter?: string }): Promise<PickerOption[]> {
  const session = await who();
  const p = z.object({ kind: z.enum(['material', 'party', 'user', 'countLine', 'customerPo', 'job']), query: z.string().max(100), role: z.enum(['SUPPLIER', 'CUSTOMER']).optional(), forId: z.string().max(64).optional(), filter: z.string().max(20).optional() }).safeParse(input);
  if (!session || !p.success) return [];
  return pickerOptions(session, p.data.kind, p.data.query, { role: p.data.role, forId: p.data.forId, filter: p.data.filter });
}

/** An earlier chat, as the person's own. */
export async function loadChatAction(id: string): Promise<{ ok: boolean; items: ChatItem[] }> {
  const session = await who();
  if (!session || !uuid.safeParse(id).success) return { ok: false, items: [] };
  const items = await conversations.items(session.userId, id);
  return items ? { ok: true, items } : { ok: false, items: [] };
}

/** The name behind an id the assistant filled into a picker. */
export async function pickerLabelAction(input: { kind: PickerKind; id: string }): Promise<PickerOption | null> {
  const session = await who();
  const p = z.object({ kind: z.enum(['material', 'party', 'user', 'countLine', 'customerPo', 'job']), id: z.string().min(1).max(64) }).safeParse(input);
  if (!session || !p.success) return null;
  return pickerLabel(session, p.data.kind, p.data.id);
}

/** The count sheet in the panel: the count in progress, with its rows. */
export async function loadSheetAction(): Promise<{ ok: true; data: SheetData } | { ok: false; message: string }> {
  const session = await who();
  if (!session) return { ok: false, message: LOGGED_OUT.message };
  const r = await loadSheet(session);
  return r.ok ? { ok: true, data: r.data } : { ok: false, message: r.message };
}

const editSchema = z.object({
  stockCountLineId: z.string().min(1).max(64),
  countedQty: z.number().finite().min(0).max(1e9).nullish(),
  reasonCode: z.string().max(20).nullish(),
  unitRate: z.number().finite().min(0).max(1e9).nullish(),
  sourceInvoiceNo: z.string().max(60).nullish(),
  sourceInvoiceDate: z.string().max(10).nullish(),
});

/** A row (or a few) typed on the count sheet. Saved through the gateway as the person's own form. */
export async function saveSheetAction(input: { stockCountId: string; edits: SheetEdit[] }) {
  const session = await who();
  if (!session) return LOGGED_OUT;
  const p = z.object({ stockCountId: z.string().min(1).max(64), edits: z.array(editSchema).min(1).max(50) }).safeParse(input);
  if (!p.success) return { ok: false as const, code: 'INVALID_INPUT', message: 'Something went wrong. Please try again.' };
  return saveSheetRows(session, p.data.stockCountId, p.data.edits);
}

/**
 * "Send back" on an approval card: the Approve form is closed and the Send-back form (with its note box) opens in its
 * place, for the same thing. Each is its own form for its own tool, so the same rules apply to each.
 */
export async function switchFormAction(input: { pendingId: string; conversationId?: string | null }): Promise<OpenFormResult> {
  const session = await who();
  if (!session) return LOGGED_OUT;
  const p = z.object({ pendingId: uuid, conversationId: uuid.nullish() }).safeParse(input);
  if (!p.success) return { ok: false, code: 'INVALID_INPUT', message: 'Something went wrong. Please try again.' };
  const from = await pendingActions.get(session, p.data.pendingId);
  const tool = from ? registry.get(from.tool) : undefined;
  if (!from || !tool || tool.kind !== 'write' || !tool.form.alt) return { ok: false, code: 'NOT_FOUND', message: "That form isn't open any more." };
  const conv = await ensureConversation(session, from.conversationId ?? p.data.conversationId);
  if (!conv) return { ok: false, code: 'NOT_FOUND', message: "Couldn't find that chat." };
  const opened = await pendingActions.create(session, { tool: tool.form.alt.tool, origin: 'LAUNCHER', conversationId: conv.id });
  if (!opened.ok) return opened;
  await pendingActions.cancel(session, from.id);
  const card = await pendingActions.formCard(session, opened.data);
  const row = await conversations.append(conv.id, 'CARD', { kind: 'card', card });
  return { ok: true, conversationId: conv.id, created: false, items: [{ id: row.id, role: 'card', card, state: 'open' }] };
}
