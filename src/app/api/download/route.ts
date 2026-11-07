import { z } from 'zod';
import { readToolsFor } from '@/lib/catalog';
import { record } from '@/server/artifacts/store';
import { exportFailure, exportAllowed, fileResponse, jsonError, sessionOr401 } from '@/server/artifacts/route-helpers';
import { tableFile } from '@/server/artifacts/table-export';
import { registry, runTool } from '@/server/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const query = z.object({ tool: z.string().min(1).max(60), input: z.string().max(4000).optional(), format: z.enum(['xlsx', 'csv']), title: z.string().max(80).optional() });

/** A table from the chat as Excel or CSV. The read runs again here, as the person downloading, so the file is current and role-safe. */
export async function GET(req: Request) {
  const s = await sessionOr401();
  if ('res' in s) return s.res;
  const me = s.me;
  const q = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return jsonError(400, 'Choose a file type.');
  if (!exportAllowed(me.userId)) return jsonError(429, 'Please wait a moment before the next file.');
  const t = registry.get(q.data.tool);
  if (!t || t.kind !== 'read' || !readToolsFor(me.role).includes(q.data.tool)) return jsonError(403, "This isn't available to you.");
  let input: unknown = {};
  try { input = q.data.input ? JSON.parse(q.data.input) : {}; } catch { return jsonError(400, "Couldn't make that file. Try again."); }
  try {
    const out = await runTool(me, q.data.tool, input);
    if (!out.ok) return jsonError(422, out.message);
    const file = await tableFile({ tool: q.data.tool, data: out.data, format: q.data.format, title: q.data.title });
    await record({ who: me, entityId: `table:${q.data.tool}`, action: 'DOWNLOAD', after: { tool: q.data.tool, format: q.data.format, role: me.role, file: file.filename } });
    return fileResponse(file);
  } catch (e) { return exportFailure(e); }
}
