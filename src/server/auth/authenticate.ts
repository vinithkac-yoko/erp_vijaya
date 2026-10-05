import { z } from 'zod';
import { db } from '../db';
import { verifyPassword } from './password';
import { isBlocked, recordFailure, recordSuccess } from './rate-limit';

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, 'Type your email.').max(200),
  password: z.string().min(1, 'Type your password.').max(200),
});

export interface SessionUser { id: string; name: string; role: 'OWNER' | 'STOREKEEPER'; theme: string | null }

export type AuthResult =
  | { ok: true; user: SessionUser }
  | { ok: false; message: string };

export const WRONG = 'The email or password is not right. Check it and try again.';
export const LOCKED = 'Too many tries. Please wait 15 minutes and try again.';

/** Checks a login. The message never says which half was wrong, or whether the email exists. */
export async function authenticate(input: unknown, ip = 'unknown'): Promise<AuthResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? WRONG };
  const { email, password } = parsed.data;

  if (isBlocked(ip, email)) return { ok: false, message: LOCKED };

  const user = await db.user.findUnique({ where: { email } });
  const good = await verifyPassword(password, user?.passwordHash);
  if (!user || !good || !user.isActive) {
    recordFailure(ip, email);
    return { ok: false, message: WRONG };
  }
  recordSuccess(ip, email);
  return { ok: true, user: { id: user.id, name: user.name, role: user.role, theme: user.theme } };
}
