import { checkPrintRequest } from '@/lib/artifacts/check';
import { printInput } from '@/server/artifacts/app-tools';
import { printoutPdf, renderPrintout } from '@/server/artifacts/printouts';
import { record } from '@/server/artifacts/store';
import { exportAllowed, exportFailure, fileResponse, jsonError, sessionOr401 } from '@/server/artifacts/route-helpers';
import { runTool } from '@/server/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A printout as a PDF (A4, with the letterhead), made from the fixed template with the facts read as the person asking. ?download=1 saves it instead of showing it. */
export async function GET(req: Request, ctx: { params: Promise<{ template: string }> }) {
  const s = await sessionOr401();
  if ('res' in s) return s.res;
  const me = s.me;
  const { template } = await ctx.params;
  const allowed = checkPrintRequest(template, me.role);
  if (!allowed.ok) return jsonError(403, allowed.message ?? 'That printout is not available to you.');
  if (!exportAllowed(me.userId)) return jsonError(429, 'Please wait a moment before the next file.');
  const url = new URL(req.url);
  const ref = Object.fromEntries([...url.searchParams.entries()].filter(([k]) => k !== 'download').map(([k, v]) => [k, v.slice(0, 80)]));
  try {
    const out = await runTool(me, 'get_print_data', printInput(template, ref));
    if (!out.ok) return jsonError(out.code === 'NOT_FOUND' ? 404 : 422, out.message);
    const p = renderPrintout(out.data);
    const pdf = await printoutPdf(p.html);
    await record({ who: me, entityId: `print:${template}`, action: 'PRINT', after: { template, title: p.title, role: me.role } });
    return fileResponse({ filename: `${p.filename}.pdf`, mime: 'application/pdf', bytes: pdf }, url.searchParams.get('download') !== '1');
  } catch (e) { return exportFailure(e); }
}
