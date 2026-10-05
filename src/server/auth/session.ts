import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getIronSession, type SessionOptions } from 'iron-session';
import { db } from '../db';
import { env } from '../env';
import type { SessionUser } from './authenticate';

/** What the sealed cookie holds: only who you are. Name, role and theme are read fresh from the database. */
export interface SessionData { userId?: string }

export const SESSION_COOKIE = 'vijaya_session';
const SEVEN_DAYS = 60 * 60 * 24 * 7;

export function sessionOptions(): SessionOptions {
  return {
    password: env().SESSION_SECRET,
    cookieName: SESSION_COOKIE,
    ttl: SEVEN_DAYS,
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
  return { id: user.id, name: user.name, role: user.role, theme: user.theme };
});

/** For pages: send people who are not logged in to the login page. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}
