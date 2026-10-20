import { currentUser } from '../auth/session';
import { allowMessage } from '../chat/rate-limit';
import type { ToolSession } from '../tools/types';
import { ExportError, type ExportResult } from './export';

export const jsonError = (status: number, message: string) => Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function sessionOr401(): Promise<{ me: ToolSession } | { res: Response }> {
  const u = await currentUser();
  if (!u) return { res: jsonError(401, 'Please log in again.') };
  return { me: { userId: u.id, name: u.name, role: u.role } };
}

/** Files are made with a headless browser: at most 10 a minute per person. */
export const exportAllowed = (userId: string) => allowMessage(`export:${userId}`, 10);

export function fileResponse(r: ExportResult, inline = false): Response {
  return new Response(new Uint8Array(r.bytes), {
    headers: {
      'Content-Type': r.mime, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${r.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** What a failed export says: plain words, never the reason inside. */
export function exportFailure(e: unknown): Response {
  if (e instanceof ExportError) {
    const msg: Record<string, string> = {
      FORMAT: e.message, NOT_ALLOWED: "This isn't available to you.", NO_TABLE: e.message, TOO_TALL: 'Too long for one picture. Download it as a PDF instead.',
      LEAK: "Couldn't make that file. Try again.", NO_BROWSER: "Couldn't make that file. Try again.", INVALID: e.message,
    };
    return jsonError(e.code === 'NOT_ALLOWED' ? 403 : 422, msg[e.code] ?? "Couldn't make that file. Try again.");
  }
  console.error('[export] failed:', e instanceof Error ? e.name : 'unknown');
  return jsonError(500, "Couldn't make that file. Try again.");
}
