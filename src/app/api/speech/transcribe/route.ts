import { currentUser } from '@/server/auth/session';
import { allowTranscribe } from '@/server/chat/rate-limit';
import { AUDIO_TYPE, MAX_AUDIO_BYTES, TranscribeError, transcribe, voiceAvailable } from '@/server/tools/transcribe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * A recording in, the words out. Any logged-in person may use it (storekeeper and owner); the session cookie says who. The
 * recording is checked for size and kind, handed to the listener and forgotten: it is never stored, logged or put in the audit.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return json(401, { error: 'Please log in again.' });
  if (!voiceAvailable()) return json(503, { error: 'Voice is not set up here. Please type it.' });
  if (!allowTranscribe(user.id)) return json(429, { error: 'That is a lot of recordings. Please wait a minute.' });
  if (Number(req.headers.get('content-length') ?? 0) > MAX_AUDIO_BYTES + 10_000) return json(413, { error: 'That recording is too long. Please keep it under a minute.' });

  const form = await req.formData().catch(() => null);
  const audio = form?.get('audio');
  if (!(audio instanceof Blob) || audio.size === 0) return json(400, { error: "Didn't hear anything. Please try again." });
  if (audio.size > MAX_AUDIO_BYTES) return json(413, { error: 'That recording is too long. Please keep it under a minute.' });
  if (!AUDIO_TYPE.test(audio.type)) return json(415, { error: "This phone's recording can't be used. Please type it." });

  try {
    const text = await transcribe(new Uint8Array(await audio.arrayBuffer()), audio.type);
    if (!text) return json(422, { error: "Didn't hear anything. Please try again." });
    return json(200, { text });
  } catch (e) {
    return json(502, { error: e instanceof TranscribeError ? e.message : "Couldn't listen just now. Please try again, or type it." });
  }
}
