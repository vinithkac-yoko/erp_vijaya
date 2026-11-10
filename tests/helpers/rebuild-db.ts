import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { loadTestEnv } from './env';

/**
 * Builds the test database from nothing: drop the schema, then `prisma migrate deploy` exactly as Railway does on an
 * empty database. So a changed migration is always what the tests run against, and "migrations work on an empty
 * database" is proved every run. Refuses to touch any database whose name does not end in _test.
 */
export async function rebuildTestDatabase(): Promise<void> {
  loadTestEnv();
  const name = new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) throw new Error(`Refusing to wipe "${name}": tests only run against a database whose name ends in _test.`);

  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  } finally {
    await prisma.$disconnect();
  }
  execSync('pnpm exec prisma migrate deploy', { stdio: 'pipe', env: process.env });
}
