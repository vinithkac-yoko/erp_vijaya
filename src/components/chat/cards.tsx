'use client';

import { useState } from 'react';
import { Download, FileText, Info, LayoutDashboard, Printer, TriangleAlert } from 'lucide-react';
import type { Card } from '@/lib/cards';
import { cn } from '@/lib/cn';
import { TamilButton, useTamil } from '@/components/translate/tamil';

type Of<K extends Card['kind']> = Extract<Card, { kind: K }>;

/** The first card in a new chat. Drawn by the server from read tools; a line with a question has a button that asks it. */
export function OpeningCard({ card, onAsk, onSheet, onDecisions, onForm, assistantOn }: { card: Of<'opening'>; onAsk: (ask: string, label: string) => void; onSheet: () => void; onDecisions: () => void; onForm: (tool: string, prefill?: Record<string, unknown>) => void; assistantOn: boolean }) {
  const pill = 'inline-flex min-h-11 md:min-h-9 items-center rounded-full border border-line bg-copper-wash px-4 text-base font-medium text-copper-deep enabled:hover:border-copper disabled:cursor-not-allowed disabled:text-ink-faint';
  const ta = useTamil([card.title, ...card.lines.map((l) => l.text)]);
  return (
    <section aria-label="Welcome" className="rounded-md border border-line border-l-4 border-l-copper bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1 lang={ta.lang(card.title)} className="font-display text-xl font-bold">{ta.show(card.title)}</h1>
        <TamilButton tamil={ta} />
      </div>
      <ul className="mt-2 space-y-2">
        {card.lines.map((l) => (
          <li key={l.text} className="flex flex-wrap items-center gap-3">
            <span lang={ta.lang(l.text)} className="text-lg">{ta.show(l.text)}</span>
            {/* the buttons that only open something (the sheet, a form) work with the assistant off; the ones that ask it do not */}
            {l.sheet && l.button && <button type="button" onClick={onSheet} className={pill}>{l.button}</button>}
            {l.decisions && l.button && <button type="button" onClick={onDecisions} className={pill}>{l.button}</button>}
            {l.form && l.button && <button type="button" onClick={() => onForm(l.form as string, l.prefill)} className={pill}>{l.button}</button>}
            {l.ask && l.button && <button type="button" disabled={!assistantOn} onClick={() => onAsk(l.ask as string, l.button as string)} className={pill}>{l.button}</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A short table. Words left, numbers right in a tabular font; the unit is part of the number. */
export function TableCard({ card }: { card: Of<'table'> }) {
  return (
    <div className="rounded-md border border-line bg-surface">
      {card.title && <p className="border-b border-line px-3 py-2 font-medium">{card.title}</p>}
      {card.rows.length > 0 && (
        <div className="overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-[-2px]" role="region" aria-label={card.title ?? 'Table'} tabIndex={0}>
          <table className="w-full border-collapse text-[15px]">
            <thead>
              <tr>{card.columns.map((c) => <th key={c.key} scope="col" className={cn('bg-sunk px-3 py-2 font-semibold', c.align === 'right' ? 'text-right' : 'text-left')}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {card.rows.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  {card.columns.map((c) => <td key={c.key} className={cn('px-3 py-2', c.align === 'right' ? 'num text-right' : 'text-left')}>{r[c.key]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {card.note && <p className={cn('px-3 py-2 text-ink-soft', card.rows.length > 0 && 'border-t border-line')}>{card.note}</p>}
      {card.rows.length === 0 && !card.note && <p className="px-3 py-3 text-ink-soft">Nothing to show.</p>}
    </div>
  );
}

/** An answer from the assistant, with the button that puts it in Tamil. */
export function AssistantText({ text }: { text: string }) {
  const ta = useTamil([text]);
  return (
    <div>
      <p lang={ta.lang(text)} className="whitespace-pre-wrap rounded-md border border-line border-l-4 border-l-copper bg-surface px-4 py-3">{ta.show(text)}</p>
      <TamilButton tamil={ta} className="mt-1" />
    </div>
  );
}

export function NoticeCard({ card }: { card: Of<'notice'> }) {
  const warn = card.tone === 'warn';
  const ta = useTamil([card.text]);
  return (
    <div>
      <p role="status" lang={ta.lang(card.text)} className={cn('flex items-start gap-2 rounded-md border px-4 py-3', warn ? 'border-attention bg-copper-wash text-ink' : 'border-line bg-surface text-ink-soft')}>
        {warn ? <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-attention" /> : <Info aria-hidden className="mt-0.5 size-5 shrink-0" />}
        {ta.show(card.text)}
      </p>
      <TamilButton tamil={ta} className="mt-1" />
    </div>
  );
}

/** The rubber stamp. Drawn from the audit row after a save; nothing the assistant said can put one here. The stamp itself stays in English. */
export function SavedCard({ card }: { card: Of<'saved'> }) {
  const ta = useTamil(card.lines);
  return (
    <section aria-label="Saved" className="rounded-md border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="stamp">✓ {card.stamp}</span>
        <TamilButton tamil={ta} />
      </div>
      <ul className="mt-3 space-y-0.5">
        {card.lines.map((l, i) => <li key={i} lang={ta.lang(l)} className={i === 0 ? 'font-medium' : 'text-ink-soft'}>{ta.show(l)}</li>)}
      </ul>
    </section>
  );
}

const openButton = 'inline-flex min-h-11 md:min-h-9 shrink-0 items-center gap-2 rounded-md border border-copper bg-copper px-4 font-semibold text-on-copper hover:bg-copper-deep';

/** "Below minimum · v1 — Open": always in the chat, so an artifact is never only a side effect. One tap opens it beside the chat. */
export function ArtifactCard({ card, onOpen }: { card: Of<'artifact'>; onOpen: (id: string) => void }) {
  const Icon = card.artifactKind === 'page' ? LayoutDashboard : FileText;
  return (
    <section aria-label={`${card.title}, version ${card.version}`} className="flex flex-wrap items-center gap-3 rounded-md border border-line border-l-4 border-l-copper bg-surface px-4 py-3">
      <Icon aria-hidden className="size-6 shrink-0 text-copper-deep" />
      <div className="min-w-0 flex-1"><p className="truncate font-medium">{card.title}</p><p className="text-sm text-ink-soft">{card.artifactKind === 'page' ? 'Page' : 'Document'} · version {card.version}</p></div>
      <button type="button" onClick={() => onOpen(card.artifactId)} className={openButton}>Open</button>
    </section>
  );
}

export function PrintoutCard({ card, onOpen }: { card: Of<'printout'>; onOpen: (c: Of<'printout'>) => void }) {
  return (
    <section aria-label={card.title} className="flex flex-wrap items-center gap-3 rounded-md border border-line border-l-4 border-l-copper bg-surface px-4 py-3">
      <Printer aria-hidden className="size-6 shrink-0 text-copper-deep" />
      <div className="min-w-0 flex-1"><p className="truncate font-medium">{card.title}</p><p className="text-sm text-ink-soft">Printout, ready to print or save as PDF</p></div>
      <button type="button" onClick={() => onOpen(card)} className={openButton}>Open</button>
    </section>
  );
}

/** Saves a file the server makes when the button is pressed (with the person's own role), and says what is happening. */
export async function saveFile(href: string): Promise<string | null> {
  try {
    const res = await fetch(href, { credentials: 'same-origin' });
    if (!res.ok) { const e = (await res.json().catch(() => null)) as { error?: string } | null; return e?.error ?? "Couldn't make that file. Try again."; }
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'download';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return null;
  } catch { return "Couldn't make that file. Try again."; }
}

export function DownloadCard({ card }: { card: Of<'download'> }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { setState('busy'); setErr(null); const e = await saveFile(card.href); setErr(e); setState(e ? 'idle' : 'done'); };
  return (
    <section aria-label="Download" className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface px-4 py-3">
      <Download aria-hidden className="size-6 shrink-0 text-copper-deep" />
      <p className="min-w-0 flex-1 font-medium">{card.label}</p>
      <button type="button" onClick={() => void go()} disabled={state === 'busy'} className={openButton}>{state === 'busy' ? 'Preparing…' : state === 'done' ? 'Download again' : 'Download'}</button>
      {err && <p role="alert" className="basis-full text-alert">{err}</p>}
    </section>
  );
}
