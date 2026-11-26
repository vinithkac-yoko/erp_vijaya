import { db } from './db';
import { configProblems } from './env';
import { checkGuards } from './guards';

export interface Health {
  ok: boolean;
  config: 'ok' | { missing: string[] };
  database: 'ok' | 'down';
  guards: { expected: number; missing: string[] } | 'unknown';
}

/** Public, unauthenticated. Says whether the app is fit to serve, never anything about the data. */
export async function health(): Promise<Health> {
  const problems = configProblems();
  let database: Health['database'] = 'down';
  let guards: Health['guards'] = 'unknown';
  try {
    await db.$queryRaw`SELECT 1`;
    database = 'ok';
    guards = await checkGuards();
  } catch {
    // swallow: the status below already says what is wrong, and the message could name the database host
  }
  const ok = problems.length === 0 && database === 'ok' && guards !== 'unknown' && guards.missing.length === 0;
  return { ok, config: problems.length === 0 ? 'ok' : { missing: problems }, database, guards };
}
