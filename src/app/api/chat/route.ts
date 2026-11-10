import { z } from 'zod';
import { launcherFor } from '@/lib/launcher/launcher';
import { currentUser } from '@/server/auth/session';
import { ensureConversation } from '@/server/chat/conversation';
import { allowMessage } from '@/server/chat/rate-limit';
import { assistantRuntime } from '@/server/chat/runtime';
import type { ChatEvent } from '@/server/agent/events';
import { openFor } from '@/server/artifacts/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({
  conversationId: z.string().uuid().optional().nullable(),
  message: z.string().trim().min(1, 'Type a message.').max(2000, 'That message is too long.'),
  chip: z.string().max(40).optional(),
  /** The artifact open beside the chat: "change it" and "download it" mean this one. Checked against what this person may open. */
  artifactId: z.string().uuid().optional().nullable(),
});

const json = (status: number, message: string) => Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * One message in, one stream of events out (one JSON object per line). The same endpoint the buttons' chips and the
 * typed box both use. Who is asking comes from the session cookie; nothing in the body can change the role.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return json(401, 'Please log in again.');
  const session = { userId: user.id, name: user.name, role: user.role };

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, parsed.error.issues[0]?.message ?? 'Please check your message.');
  const { message, conversationId } = parsed.data;

  const { agent, config } = await assistantRuntime();
  if (!allowMessage(user.id, config.messagesPerMinute)) return json(429, 'You are sending messages very fast. Please wait a moment.');

  let openArtifactId: string | undefined;
  if (parsed.data.artifactId) { try { openArtifactId = (await openFor(session, parsed.data.artifactId)).artifactId; } catch { openArtifactId = undefined; } }

  const conv = await ensureConversation(session, conversationId);
  if (!conv) return json(404, "Couldn't find that chat.");

  // A chip label only counts if this role has that chip (owner chips mean nothing to the storekeeper).
  const l = launcherFor(user.role);
  const chip = [...l.chips, ...l.moreChips].find((c) => c.label === parsed.data.chip && c.prompt === message)?.label;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ChatEvent) => { try { controller.enqueue(encoder.encode(JSON.stringify(e) + '\n')); } catch { /* the browser went away */ } };
      send({ type: 'conversation', id: conv.id });
      try {
        await agent.runTurn({ session, conversationId: conv.id, text: message, chip, openArtifactId, emit: send, signal: req.signal });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}
