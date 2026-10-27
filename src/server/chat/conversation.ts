import { conversations } from '../tools';
import type { ToolSession } from '../tools/types';
import { openingFor } from './opening';

/**
 * The chat a message belongs to: the person's own existing one, or a new one that starts with the opening card (saved as
 * its first line, so the history shows it too). Returns null for a chat that is not theirs.
 */
export async function ensureConversation(session: ToolSession, id?: string | null): Promise<{ id: string; created: boolean } | null> {
  if (id) return (await conversations.own(session.userId, id)) ? { id, created: false } : null;
  const conv = await conversations.create(session.userId);
  const { card } = await openingFor(session);
  await conversations.append(conv.id, 'CARD', { kind: 'card', card });
  return { id: conv.id, created: true };
}
