import type { Prisma, PrismaClient } from '@prisma/client';
import type { Card, ChatItem } from '@/lib/cards';
import { db } from '../db';

/**
 * What is kept for a chat. The assistant's replies are stored exactly as the API returned them (every block), so the
 * next turn can send them back unchanged; the browser's view is worked out from these rows.
 */
export type Stored =
  | { kind: 'text'; text: string; chip?: string }            // what the person typed
  | { kind: 'api'; blocks: unknown[] }                       // the assistant's reply, as returned
  | { kind: 'tool_results'; blocks: unknown[] }              // answers to the assistant's tool calls (hidden)
  | { kind: 'notice'; text: string }                         // a note from the server to the assistant (hidden)
  | { kind: 'card'; card: Card };                            // a card the server drew

const toJson = (v: unknown) => v as Prisma.InputJsonValue;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight in India time, as a UTC instant: when "today" started for the daily token budget. */
export function startOfIndiaDay(now: Date): Date {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  return new Date(Math.floor((now.getTime() + IST_OFFSET) / DAY_MS) * DAY_MS - IST_OFFSET);
}

export interface RunUsage { inputTokens: number; outputTokens: number }

export function conversationStore(client: PrismaClient = db) {
  const store = {
    async create(userId: string) {
      return client.conversation.create({ data: { userId } });
    },

    /** The person's own chat, or null. */
    async own(userId: string, id: string) {
      return client.conversation.findFirst({ where: { id, userId } });
    },

    async recent(userId: string, take = 20) {
      const rows = await client.conversation.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' }, take });
      return rows.map((c) => ({ id: c.id, title: c.title ?? 'New chat', updatedAt: c.updatedAt }));
    },

    async setTitleIfEmpty(id: string, text: string) {
      const title = text.replace(/\s+/g, ' ').trim().slice(0, 60);
      if (title) await client.conversation.updateMany({ where: { id, title: null }, data: { title } });
    },

    async append(conversationId: string, role: 'USER' | 'ASSISTANT' | 'CARD', content: Stored, agentRunId?: string) {
      const row = await client.message.create({ data: { conversationId, role, content: toJson(content), agentRunId } });
      await client.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      return row;
    },

    async rows(conversationId: string) {
      return client.message.findMany({ where: { conversationId }, orderBy: { seq: 'asc' } });
    },

    /** What the browser shows: the person's words, the assistant's text, and the cards. Hidden rows stay hidden. */
    async items(userId: string, conversationId: string): Promise<ChatItem[] | null> {
      if (!(await store.own(userId, conversationId))) return null;
      const rows = await store.rows(conversationId);
      const forms = rows.map((r) => r.content as unknown as Stored).flatMap((c) => (c.kind === 'card' && c.card.kind === 'form' ? [c.card.pendingId] : []));
      const pend = forms.length ? await client.pendingAction.findMany({ where: { id: { in: forms } }, select: { id: true, status: true, expiresAt: true } }) : [];
      const now = Date.now();
      const stateOf = (pid: string): 'open' | 'saved' | 'closed' => {
        const p = pend.find((x) => x.id === pid);
        if (p?.status === 'SUBMITTED') return 'saved';
        return p?.status === 'OPEN' && p.expiresAt.getTime() > now ? 'open' : 'closed';
      };
      const out: ChatItem[] = [];
      for (const r of rows) {
        const c = r.content as unknown as Stored;
        if (c.kind === 'text') out.push({ id: r.id, role: 'user', text: c.text });
        else if (c.kind === 'api') {
          const text = (c.blocks as { type?: string; text?: string }[]).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n\n').trim();
          if (text) out.push({ id: r.id, role: 'assistant', text });
        } else if (c.kind === 'card') {
          out.push({ id: r.id, role: 'card', card: c.card, ...(c.card.kind === 'form' ? { state: stateOf(c.card.pendingId) } : {}) });
        }
      }
      return out;
    },

    /** An audit row, if it is the person's own. The "Saved" card is drawn from this, never from model text. */
    async auditEvent(id: string, userId: string) {
      return client.auditEvent.findFirst({ where: { id, actorId: userId }, select: { id: true, toolName: true, action: true, afterJson: true } });
    },

    // ── agent runs ──
    async startRun(userId: string, conversationId: string, model: string) {
      return client.agentRun.create({ data: { userId, conversationId, model } });
    },
    async finishRun(id: string, status: 'DONE' | 'FAILED' | 'LIMITED', usage: RunUsage, toolCalls: unknown[], startedAt: number, error?: string) {
      await client.agentRun.update({
        where: { id },
        data: { status, toolCalls: toJson(toolCalls), inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, latencyMs: Date.now() - startedAt, finishedAt: new Date(), error: error?.slice(0, 300) },
      });
    },
    /** Tokens this person's assistant has used since midnight (India time). */
    async tokensToday(userId: string, now = new Date()) {
      const a = await client.agentRun.aggregate({ where: { userId, startedAt: { gte: startOfIndiaDay(now) } }, _sum: { inputTokens: true, outputTokens: true } });
      return (a._sum.inputTokens ?? 0) + (a._sum.outputTokens ?? 0);
    },

    // ── "top used first": what this person has pressed, counted from the record ──
    async launcherUsage(userId: string): Promise<Record<string, number>> {
      const usage: Record<string, number> = {};
      const forms = await client.auditEvent.groupBy({ by: ['toolName'], where: { actorId: userId, openedFrom: 'LAUNCHER', toolName: { not: null } }, _count: { _all: true } });
      for (const f of forms) if (f.toolName) usage[f.toolName] = f._count._all;
      const chips = await client.$queryRaw<{ chip: string; n: bigint }[]>`
        SELECT m.content->>'chip' AS chip, COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m."conversationId"
        WHERE c."userId" = ${userId} AND m.role = 'USER' AND m.content->>'chip' IS NOT NULL GROUP BY 1`;
      for (const c of chips) usage[`ask:${c.chip}`] = Number(c.n);
      return usage;
    },
  };
  return store;
}

export const conversations = conversationStore();
