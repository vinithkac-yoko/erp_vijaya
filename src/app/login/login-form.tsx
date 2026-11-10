'use client';

import { useActionState, useState } from 'react';
import { CircleAlert, Eye, EyeOff, LogIn } from 'lucide-react';
import { loginAction, type LoginState } from '@/server/auth/actions';
import { Button } from '@/components/ui/button';

const field = 'mt-1 block w-full min-h-12 rounded-md border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-faint';

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  const [show, setShow] = useState(false);
  return (
    <form action={action} className="mt-6 space-y-5" noValidate>
      {state.error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-alert bg-alert-wash p-3 text-alert">
          <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0" />
          <p className="font-medium">{state.error}</p>
        </div>
      )}
      <div>
        <label htmlFor="email" className="font-medium">Email</label>
        <input id="email" name="email" type="email" inputMode="email" autoComplete="username" autoCapitalize="none"
          spellCheck={false} required defaultValue={state.email ?? ''} className={field} />
      </div>
      <div>
        <label htmlFor="password" className="font-medium">Password</label>
        <div className="relative">
          <input id="password" name="password" type={show ? 'text' : 'password'} autoComplete="current-password" required
            className={field + ' pr-14'} />
          <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show}
            aria-label={show ? 'Hide password' : 'Show password'}
            className="absolute right-0 top-1 flex size-11 items-center justify-center rounded-md text-ink-soft hover:text-ink">
            {show ? <EyeOff aria-hidden className="size-5" /> : <Eye aria-hidden className="size-5" />}
          </button>
        </div>
      </div>
      <Button type="submit" disabled={pending} className="w-full min-h-12">
        <LogIn aria-hidden className="size-5" />
        {pending ? 'Logging in…' : 'Log in'}
      </Button>
    </form>
  );
}
