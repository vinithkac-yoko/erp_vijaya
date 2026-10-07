import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionOr401 } from '@/server/artifacts/route-helpers';

export const runtime = 'nodejs';
let cached: string | undefined;

/** The diagram library (about 5 MB), fetched only when a document has a diagram. Returned as text to be put in the frame, never run on our page. */
export async function GET() {
  const s = await sessionOr401();
  if ('res' in s) return s.res;
  cached ??= readFileSync(join(process.cwd(), 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8');
  return new Response(cached, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
}
