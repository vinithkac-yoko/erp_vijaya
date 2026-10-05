import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Brings the test database up to date the same way Railway does on every start.
export default function setup() {
  if (existsSync('.env.test')) process.loadEnvFile('.env.test');
  execSync('pnpm exec prisma migrate deploy', { stdio: 'pipe', env: process.env });
}
