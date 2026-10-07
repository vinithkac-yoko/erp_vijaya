'use server';

import { z } from 'zod';
import type { ChatItem } from '@/lib/cards';
import type { PickerOption } from '@/lib/forms';
import { currentUser } from '../auth/session';
import { conversations, pendingActions, registry } from '../tools';
import type { ToolSession } from '../tools/types';
import { ensureConversation } from './conversation';
import { pickerOptions } from './pickers';
import { assistantRuntime } from './runtime';
import { submitAndFollow, type SubmitResult } from './submit';

const LOGGED_OUT = { ok: false as const, code: 'LOGGED_OUT', message: 'Please log in again.' };
const uuid = z.string().uuid();

async function who(): Promise<ToolSession | null> {
  const u = await currentUser();
  return u ? { userId: u.id, name: u.name, role: u.role } : null;
}

export type OpenFormResult =
  | { ok: true; conversationId: string; created: boolean; items: ChatItem[] }
  | { ok: false; code: string; message: string };

/** A launcher button: opens the tool's form with nothing filled in. No model is involved, so it works with the assistant off. */
export async function openFormAction(input: { tool: string; conversationId?: string | null }): Promise<OpenFormResult> {
  const session = await who();
  if (!session) return LOGGED_OUT;
  const p = z.object({ tool: z.string().min(1).max(60), conversationId: uuid.nullish() }).safeParse(input);
  if (!p.success) return { ok: false, code: 'INVALID_INPUT', message: 'Something went wrong. Please try again.' };
  const conv = await ensureConversation(session, p.data.conversationId);
  if (!conv) return { ok: false, code: 'NOT_FOUND', message: "Couldn't find that chat." };
  const opened = await pendingActions.create(session, { tool: p.data.tool, origin: 'LAUNCHER', conversationId: conv.id });
  if (!opened.ok) return opened;
  const tool = registry.get(p.data.tool);
  if (!tool || tool.kind !== 'write') return { ok: false, code: 'NOT_A_FORM', message: "That isn't a form." };
  const card = { kind: 'form' as const, pendingId: opened.data.id, tool: p.data.tool, form: tool.form, values: opened.data.input, assisted: false };
  const row = await conversations.append(conv.id, 'CARD', { kind: 'card', card });
  const items: ChatItem[] = [];
  if (conv.created) for (const r of (await conversations.items(session.userId, conv.id)) ?? []) if (r.id !== row.id) items.push(r);
  items.push({ id: row.id, role: 'card', card, state: 'open' });
  return { ok: true, conversationId: conv.id, created: conv.created, items };
}

/** The form's button. The server does the save and draws the "Saved" card; a refusal comes back with the field it belongs to. */
export async function submitFormAction(input: { pendingId: string; values: Record<string, unknown> }): Promise<SubmitResult | typeof LOGGED_OUT> {
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
export async function pickerAction(input: { kind: 'material' | 'party' | 'user'; query: string; role?: 'SUPPLIER' | 'CUSTOMER' }): Promise<PickerOption[]> {
  const session = await who();
  const p = z.object({ kind: z.enum(['material', 'party', 'user']), query: z.string().max(100), role: z.enum(['SUPPLIER', 'CUSTOMER']).optional() }).safeParse(input);
  if (!session || !p.success) return [];
  return pickerOptions(session, p.data.kind, p.data.query, p.data.role);
}

/** An earlier chat, as the person's own. */
export async function loadChatAction(id: string): Promise<{ ok: boolean; items: ChatItem[] }> {
  const session = await who();
  if (!session || !uuid.safeParse(id).success) return { ok: false, items: [] };
  const items = await conversations.items(session.userId, id);
  return items ? { ok: true, items } : { ok: false, items: [] };
}
