'use client';

import { useCallback, useMemo, useState } from 'react';
import { Languages } from 'lucide-react';
import { translateAction } from '@/server/chat/actions';
import { cn } from '@/lib/cn';

/** What the screen has already been told in Tamil, so pressing the button again (or on the same words elsewhere) costs nothing. */
const known = new Map<string, string>();

/**
 * "தமிழ்" on request. The words stay English until the person presses the button; pressing it again brings the English back.
 * Anything that could not be put into Tamil safely (a number would change) stays in English.
 */
export function useTamil(texts: string[]) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, bump] = useState(0);
  const joined = texts.join('\u0000');
  const wanted = useMemo(() => [...new Set(joined.split('\u0000').filter((t) => t.trim()))], [joined]);

  const toggle = useCallback(async () => {
    if (on) { setOn(false); setError(null); return; }
    setError(null);
    const need = wanted.filter((t) => !known.has(t));
    if (need.length) {
      setBusy(true);
      const r = await translateAction({ texts: need });
      setBusy(false);
      if (!r.ok) { setError(r.message); return; }
      r.texts.forEach((t, i) => { if (t) known.set(need[i]!, t); });
      if (!wanted.some((t) => known.has(t))) { setError("Couldn't put this in Tamil. It stays in English."); return; }
      bump((n) => n + 1);
    }
    setOn(true);
  }, [on, wanted]);

  const show = (text: string) => (on ? known.get(text) ?? text : text);
  const lang = (text: string): 'ta' | undefined => (on && known.has(text) ? 'ta' : undefined);
  return { on, busy, error, toggle, show, lang };
}

export type Tamil = ReturnType<typeof useTamil>;

/** The button, and the one line that says why it did not work. */
export function TamilButton({ tamil, className }: { tamil: Tamil; className?: string }) {
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-2', className)}>
      <button type="button" onClick={() => void tamil.toggle()} disabled={tamil.busy} aria-pressed={tamil.on}
        aria-label={tamil.on ? 'Show in English' : 'Show in Tamil'}
        className="inline-flex min-h-11 md:min-h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-sm font-medium text-ink-soft hover:border-copper hover:text-copper-deep disabled:cursor-wait disabled:opacity-70">
        <Languages aria-hidden className="size-4" />
        {tamil.busy ? <span>…</span> : tamil.on ? <span>English</span> : <span lang="ta">தமிழ்</span>}
      </button>
      {tamil.error && <span role="alert" className="text-sm text-alert">{tamil.error}</span>}
    </span>
  );
}
