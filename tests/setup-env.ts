import { loadTestEnv } from './helpers/env';

// Tests run against a real Postgres: the _test database from .env.test, never the dev one.
loadTestEnv();
process.env.SESSION_SECRET ??= 'test-secret-test-secret-test-secret-123456';
