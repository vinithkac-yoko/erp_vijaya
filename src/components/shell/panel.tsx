'use client';

import { useEffect, useRef } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * The panel beside the chat (artifacts, expanded forms, printouts arrive in later milestones).
 *  ≥ 1280 px: sits beside the chat (45%).  768–1279 px: slides over the chat from the right.
 *  < 768 px (the owner's phone): a full-screen sheet with a clear "Back to chat".
 * It never opens by itself — only something the person asked for opens it.
 */
export function Panel({ open, title, onClose, children, fill, wide }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode; /** The content scrolls by itself (the count sheet). */ fill?: boolean; /** A big form takes more room; the chat narrows to a slim column beside it. */ wide?: boolean }) {
  const back = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (open) { opener.current = document.activeElement; back.current?.focus(); }
    else if (opener.current instanceof HTMLElement) { opener.current.focus(); opener.current = null; }
  }, [open]);

  if (!open) return null;
  return (
    <aside aria-label={title} data-testid="panel"
      className={cn(
        'z-30 flex min-h-0 flex-col bg-surface',
        // phone: full-screen sheet
        'fixed inset-0 top-0',
        // tablet: overlay from the right
        'md:absolute md:inset-y-0 md:left-auto md:right-0 md:w-[min(560px,92%)] md:border-l md:border-line md:shadow-lg',
        // desktop: beside the chat
        wide ? 'xl:static xl:w-[68%] xl:shrink-0 xl:shadow-none' : 'xl:static xl:w-[45%] xl:shrink-0 xl:shadow-none',
      )}>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <button ref={back} type="button" onClick={onClose}
          className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 font-medium text-copper-deep hover:bg-copper-wash md:hidden">
          <ArrowLeft aria-hidden className="size-5" />Back to chat
        </button>
        <h2 className="font-display text-lg font-bold md:pl-2">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close panel"
          className="ml-auto hidden size-9 items-center justify-center rounded-md text-ink-soft hover:bg-copper-wash md:inline-flex">
          <X aria-hidden className="size-5" />
        </button>
      </div>
      <div className={fill ? 'min-h-0 flex-1' : 'min-h-0 flex-1 overflow-y-auto p-4'}>{children}</div>
    </aside>
  );
}
