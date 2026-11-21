import { currentUser } from '@/server/auth/session';
import { saveUpload } from '@/server/tools/imports/store';
import { UploadError } from '@/server/tools/imports/files';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** A PDF or a photo is read by the model while the owner waits. */
export const maxDuration = 120;

const MAX_REQUEST = 22 * 1024 * 1024;
const json = (status: number, message: string) => Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * The owner attaches a file in the chat (milestone 16). Owner only: who is asking comes from the session cookie, and everything about the
 * file is checked from its bytes (saveUpload), never from what the browser says it is. One file per request; the answer is what was read
 * from it (sheets and their sizes), so the chat can show it, and its id, which the chat sends with the next message.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return json(401, 'Please log in again.');
  if (user.role !== 'OWNER') return json(403, 'Only the owner can attach files.');
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_REQUEST) return json(413, 'That file is too big.');
  let form: FormData;
  try { form = await req.formData(); } catch { return json(400, "I couldn't receive that file. Please try again."); }
  const file = form.get('file');
  if (!(file instanceof File)) return json(400, 'Choose a file to attach.');
  const conversation = form.get('conversationId');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { upload } = await saveUpload({ userId: user.id, name: user.name, role: user.role }, { filename: file.name, bytes, conversationId: typeof conversation === 'string' && /^[0-9a-f-]{36}$/i.test(conversation) ? conversation : null });
    return Response.json({ upload }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof UploadError) return json(400, e.message);
    console.error('[uploads] failed:', e instanceof Error ? e.message : e);
    return json(500, "I couldn't take that file just now. Please try again.");
  }
}
