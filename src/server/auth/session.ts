import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getIronSession, type SessionOptions } from 'iron-session';
import { db } from '../db';
import { env } from '../env';
import type { SessionUser } from './authenticate';
import { needsTouch, sessionStillGood } from './idle';

/** What the sealed cookie holds: only who you are. Name, role and theme are read fresh from the database. */
export interface SessionData { userId?: string; /** The user's session counter when they logged in: a password reset ends every older session. */ epoch?: number }

export const SESSION_COOKIE = 'vijaya_session';
// The cookie lasts as long as the longest idle limit (the owner's 30 days); the storekeeper's shorter one is enforced from the database.
const THIRTY_DAYS = 60 * 60 * 24 * 30;

export function sessionOptions(): SessionOptions {
  return {
    password: env().SESSION_SECRET,
    cookieName: SESSION_COOKIE,
    ttl: THIRTY_DAYS,
    cookieOptions: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' },
  };
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions());
}

/**
 * The logged-in user, or null. The role comes from the database on every request, never from the cookie, so
 * deactivating a user or changing a role takes effect at once.
 */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await getSession();
  if (!session.userId) return null;
  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user || !user.isActive) return null;
  // A password reset ends the sessions that were made before it; a long silence ends a login (docs/SAFETY.md T12).
  const now = new Date();
  if (!sessionStillGood(user, session.epoch, now)) return null;
  if (needsTouch(user.lastActiveAt, now)) await db.user.update({ where: { id: user.id }, data: { lastActiveAt: now } });
  return { id: user.id, name: user.name, role: user.role, theme: user.theme };
});

/** For pages: send people who are not logged in to the login page. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}
