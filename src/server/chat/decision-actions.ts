'use server';

import { z } from 'zod';
import { currentUser } from '../auth/session';
import { pendingActions, runTool } from '../tools';
import type { ToolSession } from '../tools/types';

/**
 * The Decisions panel's server side. The owner presses the button, which is the same as pressing a form's button: the server
 * opens the form for him and submits it in one step, through the same gateway as every other write. Owner only.
 */
export interface DecisionCard {
  id: string; topic: string; question: string; whatWeDid: string; why: string | null; options: { value: string; label: string; writeIn?: boolean }[];
  status: 'OPEN' | 'ANSWERED' | 'NEEDS_CLIENT' | 'LATER'; statusText: string; firstPass: boolean; agreedByKasi: boolean; answer: string | null; note: string | null; statusNote: string | null; answeredAt: string | null;
}
export interface DecisionList { counts: { toAnswer: number; firstPassToAnswer: number; answered: number; waitingForClient: number; later: number }; rows: DecisionCard[] }
type Done = { ok: true } | { ok: false; message: string; field?: string };

async function ownerSession(): Promise<ToolSession | null> {
  const u = await currentUser();
  return u && u.role === 'OWNER' ? { userId: u.id, name: u.name, role: u.role } : null;
}

export async function listDecisionsAction(): Promise<{ ok: true; data: DecisionList } | { ok: false }> {
  const s = await ownerSession();
  if (!s) return { ok: false };
  const r = await runTool(s, 'list_decisions', {});
  return r.ok ? { ok: true, data: r.data as DecisionList } : { ok: false };
}

async function press(s: ToolSession, tool: string, input: Record<string, unknown>): Promise<Done> {
  const opened = await pendingActions.create(s, { tool, origin: 'LAUNCHER', input });
  if (!opened.ok) return { ok: false, message: opened.message };
  const r = await runTool(s, tool, input, { confirmation: opened.data.id });
  return r.ok ? { ok: true } : { ok: false, message: r.message, field: r.field };
}

export async function answerDecisionAction(input: { decisionId: string; choice: string; note?: string }): Promise<Done> {
  const s = await ownerSession();
  const p = z.object({ decisionId: z.string().uuid(), choice: z.string().min(1).max(120), note: z.string().max(1000).optional() }).safeParse(input);
  if (!s || !p.success) return { ok: false, message: 'Please log in again.' };
  return press(s, 'answer_decision', { decisionId: p.data.decisionId, choice: p.data.choice, ...(p.data.note?.trim() ? { note: p.data.note.trim() } : {}) });
}

export async function setDecisionStatusAction(input: { decisionId: string; status: 'OPEN' | 'NEEDS_CLIENT' | 'LATER'; note?: string }): Promise<Done> {
  const s = await ownerSession();
  const p = z.object({ decisionId: z.string().uuid(), status: z.enum(['OPEN', 'NEEDS_CLIENT', 'LATER']), note: z.string().max(400).optional() }).safeParse(input);
  if (!s || !p.success) return { ok: false, message: 'Please log in again.' };
  return press(s, 'set_decision_status', { decisionId: p.data.decisionId, status: p.data.status, ...(p.data.note?.trim() ? { note: p.data.note.trim() } : {}) });
}
