// Runs once when the Node server starts. An app on an unguarded database must not serve a single request.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Not while building, when there may be no database yet.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (!process.env.DATABASE_URL) return; // /api/health reports the missing setting

  const { assertGuards } = await import('./server/guards');
  try {
    await assertGuards();
  } catch (err) {
    console.error(`[boot] ${err instanceof Error ? err.message : 'The database guard check failed.'}`);
    process.exit(1); // so the platform sees a failed start, not a server that answers 500 to everything
  }
}
