import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentUser } from '@/server/auth/session';
import { CoilLine, BrandMark } from '@/components/brand';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Log in' };

export default async function LoginPage() {
  if (await currentUser()) redirect('/');
  return (
    <main className="flex min-h-dvh flex-col bg-paper">
      <header className="relative overflow-hidden border-b-[3px] border-copper bg-plate px-5 py-4">
        <CoilLine />
        <div className="relative"><BrandMark /></div>
      </header>
      <div className="flex flex-1 items-start justify-center px-4 pt-10 md:items-center md:pt-0">
        <section aria-labelledby="login-title" className="w-full max-w-md rounded-md border border-line bg-surface p-6">
          <h1 id="login-title" className="font-display text-2xl font-bold">Log in</h1>
          <p className="mt-1 text-ink-soft">Use the email and password the owner gave you.</p>
          <LoginForm />
        </section>
      </div>
    </main>
  );
}
