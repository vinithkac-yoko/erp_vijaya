// Slows down password guessing. In memory, which is right for one app instance on Railway; if the app is
// ever run on several instances, move this into the database.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_PAIR = 5;   // one person from one place
const MAX_PER_IP = 30;    // one place, any names

type Entry = { count: number; first: number };
const hits = new Map<string, Entry>();

function current(key: string, now: number): Entry | undefined {
  const e = hits.get(key);
  if (!e) return undefined;
  if (now - e.first > WINDOW_MS) { hits.delete(key); return undefined; }
  return e;
}

export function isBlocked(ip: string, email: string, now = Date.now()): boolean {
  return (current(`pair:${ip}|${email}`, now)?.count ?? 0) >= MAX_PER_PAIR || (current(`ip:${ip}`, now)?.count ?? 0) >= MAX_PER_IP;
}

export function recordFailure(ip: string, email: string, now = Date.now()): void {
  for (const key of [`pair:${ip}|${email}`, `ip:${ip}`]) {
    const e = current(key, now);
    if (e) e.count += 1; else hits.set(key, { count: 1, first: now });
  }
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.first > WINDOW_MS) hits.delete(k);
}

export function recordSuccess(ip: string, email: string): void {
  hits.delete(`pair:${ip}|${email}`);
}

export function resetRateLimits(): void { hits.clear(); }
