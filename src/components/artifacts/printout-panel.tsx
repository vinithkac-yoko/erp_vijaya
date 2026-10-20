'use client';

import { useEffect, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { loadPrintoutAction, type LoadedPrintout } from '@/server/artifacts/actions';
import { saveFile } from '@/components/chat/cards';
import { cn } from '@/lib/cn';

const bar = 'inline-flex min-h-11 md:min-h-9 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-base font-medium text-ink hover:bg-copper-wash disabled:cursor-not-allowed disabled:opacity-60';

/**
 * A printout beside the chat. The preview is the printout's own HTML in a frame with NO permissions at all (no script,
 * no forms, no same-origin), so nothing in it can run. Print opens the PDF in its own tab, where the browser prints it.
 */
export function PrintoutPanel({ template, refs, onLoaded }: { template: string; refs: Record<string, string>; onLoaded?: (title: string) => void }) {
  const [p, setP] = useState<LoadedPrintout | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify([template, refs]);
  useEffect(() => {
    let dead = false;
    setP(null); setErr(null);
    void loadPrintoutAction({ template, ref: refs }).then((r) => { if (dead) return; if (r.ok) { setP(r.printout); onLoaded?.(r.printout.title); } else setErr(r.message); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (err) return <p role="alert" className="p-4 text-alert">{err}</p>;
  if (!p) return <p className="p-4 text-ink-soft" role="status">Getting the printout ready…</p>;
  const download = async () => { setBusy(true); const e = await saveFile(`${p.href}${p.href.includes('?') ? '&' : '?'}download=1`); setBusy(false); if (e) setErr(e); };
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="printout-panel">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2" role="toolbar" aria-label="Printout tools">
        <a href={p.href} target="_blank" rel="noopener noreferrer" className={bar}><Printer aria-hidden className="size-4" />Print</a>
        <button type="button" className={cn(bar)} onClick={() => void download()} disabled={busy}><Download aria-hidden className="size-4" />{busy ? 'Preparing…' : 'Download PDF'}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-sunk p-3">
        <iframe title={p.title} sandbox="" srcDoc={p.html} className="mx-auto block h-full min-h-[640px] w-full max-w-[820px] border border-line bg-white" />
      </div>
    </div>
  );
}
