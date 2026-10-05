import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { OWNER, STOREKEEPER } from './users';

// Fresh users in the test database, created by the real seed script.
export default async function globalSetup() {
  const prisma = new PrismaClient();
  await prisma.user.deleteMany();
  await prisma.$disconnect();
  execSync('pnpm exec tsx prisma/seed.ts', {
    stdio: 'pipe',
    env: {
      ...process.env,
      SEED_OWNER_NAME: OWNER.name, SEED_OWNER_EMAIL: OWNER.email, SEED_OWNER_PASSWORD: OWNER.password,
      SEED_STOREKEEPER_NAME: STOREKEEPER.name, SEED_STOREKEEPER_EMAIL: STOREKEEPER.email, SEED_STOREKEEPER_PASSWORD: STOREKEEPER.password,
    },
  });
}
