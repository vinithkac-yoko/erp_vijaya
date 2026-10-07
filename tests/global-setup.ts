import { rebuildTestDatabase } from './helpers/rebuild-db';

export default async function setup() {
  await rebuildTestDatabase();
}
