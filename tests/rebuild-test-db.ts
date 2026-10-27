// `pnpm e2e` runs this first, so the browser tests start from a freshly migrated database.
import { rebuildTestDatabase } from './helpers/rebuild-db';

rebuildTestDatabase().then(
  () => console.log('[tests] test database rebuilt'),
  (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); },
);
