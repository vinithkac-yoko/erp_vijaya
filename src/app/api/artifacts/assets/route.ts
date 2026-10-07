import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionOr401 } from '@/server/artifacts/route-helpers';

export const runtime = 'nodejs';

/** The sandbox's own code and look, as text. The page puts them into the artifact's frame; nothing here is secret, but only people who are logged in get it. */
const rd = (f: string) => readFileSync(join(process.cwd(), 'src/lib/artifacts/host', f), 'utf8');
let cached: Record<string, string> | undefined;

export async function GET() {
  const s = await sessionOr401();
  if ('res' in s) return s.res;
  cached ??= { tokensCss: rd('tokens.css'), bootstrapSource: rd('bootstrap.js'), uiKitSource: rd('uikit.js'), vdocSource: rd('vdoc.cjs'), docRenderSource: rd('docrender.js') };
  return Response.json(cached, { headers: { 'Cache-Control': 'private, max-age=3600' } });
}
