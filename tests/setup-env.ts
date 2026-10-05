import { existsSync } from 'node:fs';

// Tests run against a real Postgres. Use .env.test when it exists, otherwise whatever DATABASE_URL is set.
if (existsSync('.env.test')) process.loadEnvFile('.env.test');
process.env.SESSION_SECRET ??= 'test-secret-test-secret-test-secret-123456';
