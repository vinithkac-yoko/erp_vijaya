import type { PendingOrigin, PrismaClient } from '@prisma/client';
import { ARTIFACT_OPENABLE_FORMS } from '@/lib/catalog';
import { sanitizePrefill, type Origin } from '@/lib/prefill';
import { db } from '../db';
import { mapError } from '../errors';
import type { Registry } from './registry';
import type { Card } from '@/lib/cards';
import type { FormPreview, ToolOutcome, ToolSession } from './types';

/** A form stays open for 15 minutes (VIJAYA prompt §3.3). */
export const PENDING_TTL_MS = 15 * 60 * 1000;

export interface CreatePendingArgs {
  tool: string;
  /** Suggestions only. Passed through sanitizePrefill on the server, so a rate is dropped unless a person typed it. */
  input?: unknown;
  origin: PendingOrigin;
  conversationId?: string;
  agentRunId?: string;
  artifactId?: string;
  artifactVersion?: number;
}

export interface PendingView {
  id: string;
  tool: string;
  conversationId: string | null;
  input: Record<string, unknown>;
  /** True when the form has suggested values: show "assistant filled this in — check it". */
  assisted: boolean;
  dropped: string[];
  expiresAt: Date;
}

const fail = (code: string, message: string): ToolOutcome<never> => ({ ok: false, code, message });
const LOWER: Record<PendingOrigin, Origin> = { LAUNCHER: 'launcher', AGENT: 'agent', ARTIFACT: 'artifact' };

/**
 * PendingActions: the "form waiting for a person". The agent, a launcher button and an artifact can only ever create
 * one of these; nothing is written until the logged-in user submits it (runTool, with this id as the confirmation).
 */
export function createPendingService(registry: Registry, client: PrismaClient = db) {
  return {
    async create(session: ToolSession, a: CreatePendingArgs, now = new Date()): Promise<ToolOutcome<PendingView>> {
      try {
        const tool = registry.get(a.tool);
        if (!tool) return fail('UNKNOWN_TOOL', "I can't do that.");
        if (tool.kind !== 'write') return fail('NOT_A_FORM', "That isn't a form.");
        if (!tool.roles.includes(session.role)) {
          return fail('FORBIDDEN_ROLE', tool.roles.length === 1 && tool.roles[0] === 'OWNER' ? 'Only the owner can do that.' : "You can't do that.");
        }
        if (a.origin === 'ARTIFACT' && !ARTIFACT_OPENABLE_FORMS.has(a.tool)) return fail('FORM_NOT_ALLOWED', "That page can't open that form.");

        if (a.conversationId) {
          const own = await client.conversation.count({ where: { id: a.conversationId, userId: session.userId } });
          if (own !== 1) return fail('NOT_FOUND', "Couldn't find that chat.");
        }

        const clean = sanitizePrefill(a.tool, a.input, LOWER[a.origin]);
        const created = await client.$transaction(async (tx) => {
          // Opening the same form again in the same chat replaces the earlier one ("issue for job 31… actually job 32").
          await tx.pendingAction.updateMany({
            where: { userId: session.userId, toolName: a.tool, status: 'OPEN', conversationId: a.conversationId ?? null },
            data: { status: 'CANCELLED' },
          });
          return tx.pendingAction.create({
            data: {
              userId: session.userId,
              toolName: a.tool,
              proposedInput: clean.input as object,
              origin: a.origin,
              conversationId: a.conversationId,
              agentRunId: a.agentRunId,
              artifactId: a.artifactId,
              artifactVersion: a.artifactVersion,
              expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
            },
          });
        });
        return { ok: true, data: { id: created.id, tool: a.tool, conversationId: created.conversationId, input: clean.input, assisted: clean.assisted, dropped: clean.dropped, expiresAt: created.expiresAt } };
      } catch (err) {
        const m = mapError(err);
        return fail(m.code, m.message);
      }
    },

    /**
     * The card for an open form: the form, the values it starts with (what was asked for, over what the tool itself knows
     * such as today's date or which count), and the read-only facts the tool works out when it opens.
     */
    async formCard(session: ToolSession, view: PendingView): Promise<Extract<Card, { kind: 'form' }>> {
      const tool = registry.get(view.tool);
      if (!tool || tool.kind !== 'write') throw new Error(`"${view.tool}" is not a form`);
      let preview: FormPreview | undefined;
      try { preview = tool.preview ? await tool.preview({ db: client, session }, view.input) : undefined; } catch { preview = undefined; } // a form still opens if the extra facts can't be worked out
      return {
        kind: 'form', pendingId: view.id, tool: view.tool, form: tool.form, values: { ...(preview?.values ?? {}), ...view.input }, assisted: view.assisted,
        ...(preview?.info.length ? { info: preview.info } : {}),
      };
    },

    /** The person's own open, unexpired form — or null. */
    async get(session: ToolSession, id: string, now = new Date()): Promise<PendingView | null> {
      const p = await client.pendingAction.findFirst({ where: { id, userId: session.userId, status: 'OPEN', expiresAt: { gt: now } } });
      if (!p) return null;
      return { id: p.id, tool: p.toolName, conversationId: p.conversationId, input: (p.proposedInput ?? {}) as Record<string, unknown>, assisted: Object.keys((p.proposedInput ?? {}) as object).length > 0 && p.origin !== 'LAUNCHER', dropped: [], expiresAt: p.expiresAt };
    },

    /** The person's own form in ANY state (open, saved, closed): so a second press can be told "already saved", not just "gone". */
    async peek(session: ToolSession, id: string): Promise<{ tool: string } | null> {
      const p = await client.pendingAction.findFirst({ where: { id, userId: session.userId }, select: { toolName: true } });
      return p ? { tool: p.toolName } : null;
    },

    /** "Not now": closes the person's own open form. */
    async cancel(session: ToolSession, id: string): Promise<ToolOutcome<null>> {
      const r = await client.pendingAction.updateMany({ where: { id, userId: session.userId, status: 'OPEN' }, data: { status: 'CANCELLED' } });
      return r.count === 1 ? { ok: true, data: null } : fail('NOT_FOUND', "That form isn't open any more.");
    },

    /** Housekeeping: marks forms past their time as EXPIRED. Returns how many. */
    async expireStale(now = new Date()): Promise<number> {
      const r = await client.pendingAction.updateMany({ where: { status: 'OPEN', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
      return r.count;
    },
  };
}
