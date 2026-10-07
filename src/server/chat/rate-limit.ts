// At most N chat messages per person per minute (SAFETY T5/T15). In memory: right for one app instance on Railway.
const hits = new Map<string, number[]>();
const WINDOW_MS = 60_000;

/** True if this message may go ahead; false if the person is sending too fast. */
export function allowMessage(userId: string, limit: number, now = Date.now()): boolean {
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limit) { hits.set(userId, recent); return false; }
  recent.push(now);
  hits.set(userId, recent);
  return true;
}
export const resetMessageLimits = () => hits.clear();
