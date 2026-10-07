'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '../db';
import { authenticate } from './authenticate';
import { currentUser, getSession } from './session';

export interface LoginState { error?: string; email?: string }

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get('email') ?? '');
  const h = await headers();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || h.get('x-real-ip') || 'unknown';
  const result = await authenticate({ email, password: String(form.get('password') ?? '') }, ip);
  if (!result.ok) return { error: result.message, email };

  const session = await getSession();
  session.userId = result.user.id;
  session.epoch = result.user.epoch ?? 0;
  await session.save();
  redirect('/');
}

export async function logoutAction(): Promise<void> {
  const session = await getSession();
  session.destroy();
  redirect('/login');
}

const themeSchema = z.enum(['light', 'dark', 'system']);

/** Remembers the person's theme choice. 'system' means follow the device. */
export async function setThemeAction(value: string): Promise<void> {
  const user = await currentUser();
  if (!user) return;
  const theme = themeSchema.parse(value);
  await db.user.update({ where: { id: user.id }, data: { theme: theme === 'system' ? null : theme } });
  revalidatePath('/');
}
