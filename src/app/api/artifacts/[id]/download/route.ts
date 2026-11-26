import { z } from 'zod';
import { openFor, record } from '@/server/artifacts/store';
import { exportArtifact, type Format } from '@/server/artifacts/export';
import { exportAllowed, exportFailure, fileResponse, jsonError, sessionOr401 } from '@/server/artifacts/route-helpers';
import { runTool } from '@/server/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const query = z.object({ format: z.enum(['pdf', 'png', 'docx', 'xlsx', 'csv', 'md']), table: z.coerce.number().int().min(0).max(50).optional() });

/**
 * A download of an artifact, made on the server from the stored source, with every number read again AS THE PERSON
 * DOWNLOADING (docs/ARTIFACTS.md §10). Nothing comes from the browser but the format. A storekeeper who downloads a
 * document that reads an owner-only tool is refused before any data is fetched.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const s = await sessionOr401();
  if ('res' in s) return s.res;
  const me = s.me;
  const { id } = await ctx.params;
  const q = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return jsonError(400, 'Choose a file type.');
  if (!exportAllowed(me.userId)) return jsonError(429, 'Please wait a moment before the next file.');
  try {
    const a = await openFor(me, id);
    const file = await exportArtifact({
      kind: a.kind, source: a.source, role: me.role, format: q.data.format as Format, title: a.title, table: q.data.table,
      runRead: async (tool, input) => { const out = await runTool(me, tool, input); if (!out.ok) throw new Error(out.message); return out.data; },
    });
    await record({ who: me, entityId: a.artifactId, action: 'DOWNLOAD', after: { format: q.data.format, version: a.version, role: me.role, file: file.filename } });
    return fileResponse(file);
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as { code?: string }).code === 'NOT_FOUND') return jsonError(404, "Couldn't find that artifact.");
    return exportFailure(e);
  }
}
