import { execSync } from 'node:child_process';
import { OWNER, STOREKEEPER } from './users';

// Users in the test database, created by the real seed script. `pnpm e2e` rebuilds the database first.
export default function globalSetup() {
  execSync('pnpm exec tsx prisma/seed.ts', {
    stdio: 'pipe',
    env: {
      ...process.env,
      SEED_OWNER_NAME: OWNER.name, SEED_OWNER_EMAIL: OWNER.email, SEED_OWNER_PASSWORD: OWNER.password,
      SEED_STOREKEEPER_NAME: STOREKEEPER.name, SEED_STOREKEEPER_EMAIL: STOREKEEPER.email, SEED_STOREKEEPER_PASSWORD: STOREKEEPER.password,
    },
  });
}
