// Runs once when the Node server starts. Fails loudly if the database is missing a guard trigger.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Not while building, when there may be no database yet.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (!process.env.DATABASE_URL) return; // /api/health reports the missing setting
  const { assertGuards } = await import('./server/guards');
  await assertGuards();
}
