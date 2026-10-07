import { Prisma, type PendingAction, type PrismaClient } from '@prisma/client';
import { db } from '../db';
import { mapError, ToolError, UNKNOWN_CONSTRAINT } from '../errors';
import type { Registry } from './registry';
import type { Actor, RunOptions, Tx, ToolOutcome, ToolSession } from './types';

const fail = (code: string, message: string): ToolOutcome<never> => ({ ok: false, code, message });

/** Anything that looks like a secret never goes into the audit log, whatever a tool hands us (SAFETY T19). */
const SECRET_KEY = /pass(word)?|hash|secret|token|api[_-]?key/i;
export function scrub(value: unknown): unknown {
  if (value === undefined) return undefined;
  const plain = JSON.parse(JSON.stringify(value)) as unknown; // Decimals and Dates become text
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEY.test(k) ? '[hidden]' : walk(x)]));
    }
    return v;
  };
  return walk(plain);
}

const openedFrom = (o: PendingAction['origin']) => (o === 'LAUNCHER' ? 'LAUNCHER' : o === 'ARTIFACT' ? 'ARTIFACT' : 'AGENT') as 'LAUNCHER' | 'ARTIFACT' | 'AGENT';

/** Why a confirmation could not be used. Says nothing about whose form it was. */
async function whyNotClaimed(tx: Tx, id: string, userId: string, tool: string, now: Date): Promise<ToolError> {
  const p = await tx.pendingAction.findUnique({ where: { id } });
  if (!p || p.userId !== userId || p.toolName !== tool) return new ToolError('CONFIRMATION_INVALID', "That form isn't open any more. Please open it again.");
  if (p.status === 'SUBMITTED') return new ToolError('ALREADY_SUBMITTED', 'That form was already saved.');
  if (p.status === 'CANCELLED') return new ToolError('FORM_CLOSED', 'That form was closed. Please open it again.');
  if (p.status === 'EXPIRED' || p.expiresAt <= now) return new ToolError('PENDING_EXPIRED', 'That form was open for too long. Please open it again.');
  return new ToolError('CONFIRMATION_INVALID', "That form isn't open any more. Please open it again.");
}

/**
 * THE ONLY DOOR to business data. Every form, Server Action, the assistant and every artifact comes through here.
 *  1. unknown tool → refused          2. role checked from the session, on the server
 *  3. input validated, unknown keys stripped
 *  4. reads run; writes need a PendingAction this user submitted (one-shot, 15 minutes, same tool)
 *  5. a write runs in ONE transaction with ONE AuditEvent; if anything fails, nothing is kept — not even "submitted"
 *  6. every failure is turned into a named code and a plain sentence
 */
export function createRunTool(registry: Registry, client: PrismaClient = db) {
  return async function runTool(session: ToolSession, name: string, input: unknown, opts: RunOptions = {}): Promise<ToolOutcome> {
    try {
      const tool = registry.get(name);
      if (!tool) return fail('UNKNOWN_TOOL', "I can't do that.");
      if (!tool.roles.includes(session.role)) {
        return fail('FORBIDDEN_ROLE', tool.roles.length === 1 && tool.roles[0] === 'OWNER' ? 'Only the owner can do that.' : "You can't do that.");
      }
      const parsed = tool.input.safeParse(input ?? {});
      if (!parsed.success) return fail('INVALID_INPUT', parsed.error.issues[0]?.message || 'Please check what you typed.');

      const now = new Date();
      if (tool.kind === 'read') {
        const actor: Actor = { actorType: 'HUMAN', actorId: session.userId, toolName: name };
        const data = await tool.handler({ session, db: client, actor, now }, parsed.data);
        return { ok: true, data };
      }

      const confirmation = opts.confirmation;
      if (!confirmation) return fail('CONFIRMATION_REQUIRED', 'Please check the form and press its button. Nothing is saved until you do.');

      return await client.$transaction(async (tx) => {
        // Claim the form. Atomic: a double click or a second tab loses this race and changes nothing.
        const claimed = await tx.pendingAction.updateMany({
          where: { id: confirmation, userId: session.userId, toolName: name, status: 'OPEN', expiresAt: { gt: now } },
          data: { status: 'SUBMITTED', submittedAt: now },
        });
        if (claimed.count !== 1) throw await whyNotClaimed(tx, confirmation, session.userId, name, now);
        const pending = await tx.pendingAction.findUniqueOrThrow({ where: { id: confirmation } });

        const actor: Actor = {
          actorType: pending.origin === 'AGENT' ? 'AGENT' : 'HUMAN',
          actorId: session.userId,
          agentRunId: pending.agentRunId ?? undefined,
          toolName: name,
        };
        const result = await tool.handler({ session, db: tx, actor, now }, parsed.data);
        if (!result || !result.audit) throw new Error(`write tool ${name} returned no audit entry`); // fail closed

        const a = result.audit;
        const event = await tx.auditEvent.create({
          data: {
            entityType: a.entityType,
            entityId: a.entityId,
            action: a.action,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentRunId: actor.agentRunId,
            toolName: name,
            reason: a.reason,
            openedFrom: openedFrom(pending.origin),
            pendingActionId: pending.id,
            artifactId: pending.artifactId,
            artifactVersion: pending.artifactVersion,
            beforeJson: scrub(a.before) as Prisma.InputJsonValue | undefined,
            afterJson: scrub(a.after) as Prisma.InputJsonValue | undefined,
          },
        });
        return { ok: true as const, data: result.data, auditId: event.id };
      }, { timeout: 20_000, maxWait: 10_000 });
    } catch (err) {
      const mapped = mapError(err);
      if (mapped === UNKNOWN_CONSTRAINT || mapped.code === 'INTERNAL') {
        // For us, not for the screen. No input values, no stack.
        console.error(`[runTool] ${name} failed:`, err instanceof Error ? `${err.name}: ${err.message.slice(0, 500)}` : 'unknown error');
      }
      return fail(mapped.code, mapped.message);
    }
  };
}
