import { existsSync, readFileSync } from 'node:fs';

/**
 * Loads .env.test OVER whatever is already set. (`process.loadEnvFile` never overrides, and importing @prisma/client
 * loads the dev .env first, so without this the tests could end up pointed at the dev database.)
 */
export function loadTestEnv(file = '.env.test'): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (m) process.env[m[1] as string] = m[2] as string;
  }
}
