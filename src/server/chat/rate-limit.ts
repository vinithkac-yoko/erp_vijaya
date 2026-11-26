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

// Translating and listening cost money: a person may ask for at most 30 of each a minute.
const other = new Map<string, number[]>();
function allowOther(kind: string, userId: string, limit = 30, now = Date.now()): boolean {
  const key = `${kind}:${userId}`;
  const recent = (other.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limit) { other.set(key, recent); return false; }
  recent.push(now); other.set(key, recent);
  return true;
}
export const allowTranslate = (userId: string) => allowOther('translate', userId);
export const allowTranscribe = (userId: string) => allowOther('transcribe', userId);
export const resetOtherLimits = () => other.clear();
