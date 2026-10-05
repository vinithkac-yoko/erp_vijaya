'use client';

import { forwardRef } from 'react';
import { Send } from 'lucide-react';
import type { Launcher } from '@/lib/launcher/launcher';
import { LauncherRow } from './launcher';

/** The first card in a new chat. Later milestones draw it from read tools (waiting for you, below minimum…). */
function OpeningCard({ name }: { name: string }) {
  const first = name.trim().split(/\s+/)[0] ?? name;
  return (
    <section aria-label="Welcome" className="rounded-md border border-line border-l-4 border-l-copper bg-surface p-4">
      <h1 className="font-display text-xl font-bold">Welcome, {first}.</h1>
      <p className="mt-1 text-ink-soft">
        Stock, jobs and approvals will show here. The buttons below switch on one step at a time.
      </p>
    </section>
  );
}

export const Chat = forwardRef<HTMLTextAreaElement, { name: string; launcher: Launcher }>(function Chat({ name, launcher }, inputRef) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto" role="log" aria-label="Chat">
        <div className="mx-auto w-full max-w-[720px] px-4 py-5 md:py-8">
          <OpeningCard name={name} />
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-paper">
        <div className="mx-auto w-full max-w-[720px] space-y-3 px-4 py-3">
          <LauncherRow launcher={launcher} />
          <form className="flex items-end gap-2" onSubmit={(e) => e.preventDefault()}>
            <label htmlFor="chat-input" className="sr-only">Type a message</label>
            <textarea id="chat-input" ref={inputRef} rows={1} disabled
              placeholder="The assistant is not switched on yet."
              className="min-h-12 flex-1 resize-none rounded-md border border-line bg-surface px-3 py-3 text-base text-ink placeholder:text-ink-soft disabled:cursor-not-allowed" />
            <button type="submit" disabled aria-label="Send"
              className="inline-flex size-12 shrink-0 items-center justify-center rounded-md border border-copper bg-copper text-on-copper disabled:cursor-not-allowed disabled:opacity-50">
              <Send aria-hidden className="size-5" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
});
