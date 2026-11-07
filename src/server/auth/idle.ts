/**
 * How long a login stays good without use (docs/SAFETY.md T12). The storekeeper is on a shared office PC, so his is short; the
 * owner is on his own phone, so his is long. Enforced on the server, from the database, on every request: the cookie alone
 * never keeps anyone logged in.
 */
export const IDLE_LIMIT_MS = { STOREKEEPER: 12 * 60 * 60 * 1000, OWNER: 30 * 24 * 60 * 60 * 1000 } as const;
/** Activity is written at most this often, so reading a page does not write to the database every time. */
export const TOUCH_EVERY_MS = 5 * 60 * 1000;

export const idleExpired = (role: 'OWNER' | 'STOREKEEPER', lastActiveAt: Date | null, now = new Date()) =>
  !!lastActiveAt && now.getTime() - lastActiveAt.getTime() > IDLE_LIMIT_MS[role];

export const needsTouch = (lastActiveAt: Date | null, now = new Date()) => !lastActiveAt || now.getTime() - lastActiveAt.getTime() > TOUCH_EVERY_MS;

/** Is this cookie still good for this person? Not after a password reset (the counter moved on) and not after a long silence. */
export const sessionStillGood = (user: { role: 'OWNER' | 'STOREKEEPER'; lastActiveAt: Date | null; sessionEpoch: number }, cookieEpoch: number | undefined, now = new Date()) =>
  (cookieEpoch ?? 0) === user.sessionEpoch && !idleExpired(user.role, user.lastActiveAt, now);
