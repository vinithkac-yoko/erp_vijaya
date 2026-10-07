import type { Card, ChatItem, Chip } from '@/lib/cards';
import { conversations, pendingActions, registry, runTool, submitForm } from '../tools';
import type { ToolSession } from '../tools/types';
import type { Agent } from '../agent/run';

export type SubmitResult =
  | { ok: true; items: ChatItem[]; chips: Chip[] }
  | { ok: false; code: string; message: string; field?: string; details?: unknown };

/** A follow-up may read, never write: it can only call read tools. */
async function runRead(session: ToolSession, name: string, input?: unknown) {
  const t = registry.get(name);
  if (!t || t.kind !== 'read') return { ok: false as const, code: 'NOT_ALLOWED', message: 'Follow-ups can only read.' };
  return runTool(session, name, input ?? {});
}

/** A chip that opens a form is only offered if that form exists and this role may use it. */
function usable(session: ToolSession, chip: Chip): boolean {
  if (!('form' in chip)) return true;
  const t = registry.get(chip.form);
  return !!t && t.kind === 'write' && t.roles.includes(session.role);
}

/**
 * The person pressed a form's button. runTool does the write (their own open form, one-shot). If it worked, the SERVER
 * draws the "Saved" card from the audit row (never from model text), tells the assistant what was saved (so the next
 * message knows), runs the tool's follow-up checks, and has the assistant say one or two sentences only if they found
 * something. A failed save changes nothing and leaves the form open for another try.
 */
export async function submitAndFollow(session: ToolSession, pendingId: string, values: unknown, agent?: Agent): Promise<SubmitResult> {
  const form = await pendingActions.get(session, pendingId);
  const out = await submitForm(session, pendingId, values);
  if (!out.ok) return { ok: false, code: out.code, message: out.message, field: out.field, details: out.details };

  const tool = form ? registry.get(form.tool) : undefined;
  const audit = out.auditId ? await conversations.auditEvent(out.auditId, session.userId) : null;
  const items: ChatItem[] = [];
  let chips: Chip[] = [];
  if (!tool || tool.kind !== 'write' || !audit) return { ok: true, items, chips };

  const after = (audit.afterJson ?? {}) as Record<string, unknown>;
  const stamp = audit.action !== 'CREATE' && tool.stampUpdate ? tool.stampUpdate : tool.stamp;
  const card: Card = { kind: 'saved', stamp, lines: tool.describe(after), auditId: audit.id };
  const convId = form?.conversationId ?? undefined;
  if (convId) {
    const row = await conversations.append(convId, 'CARD', { kind: 'card', card });
    items.push({ id: row.id, role: 'card', card });
    await conversations.append(convId, 'USER', { kind: 'notice', text: `The user saved this (the system recorded it): ${stamp.toLowerCase()} — ${card.lines.join('; ')}.` });
  } else {
    items.push({ id: audit.id, role: 'card', card });
  }

  if (tool.followUps) {
    try {
      const f = await tool.followUps({ session, read: (name, input) => runRead(session, name, input) }, (values ?? {}) as Record<string, unknown>, out.data);
      chips = f.chips.filter((c) => usable(session, c));
      if (f.facts.length && agent && convId) {
        const sentence = await agent.followUp(session, convId, f.facts);
        if (sentence) {
          const last = (await conversations.rows(convId)).at(-1);
          items.push({ id: last?.id ?? `s-${Date.now()}`, role: 'assistant', text: sentence });
        }
      }
    } catch {
      // a failed follow-up shows nothing extra
    }
  }
  return { ok: true, items, chips };
}
