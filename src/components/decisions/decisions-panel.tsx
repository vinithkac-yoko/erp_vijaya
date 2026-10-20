'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ClipboardCopy, MessageCircleQuestion } from 'lucide-react';
import { answerDecisionAction, listDecisionsAction, setDecisionStatusAction, type DecisionCard, type DecisionList } from '@/server/chat/decision-actions';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

type Tab = 'OPEN' | 'NEEDS_CLIENT' | 'LATER' | 'ANSWERED';
const TABS: { id: Tab; label: string }[] = [{ id: 'OPEN', label: 'To answer' }, { id: 'NEEDS_CLIENT', label: 'Waiting for the client' }, { id: 'LATER', label: 'Later' }, { id: 'ANSWERED', label: 'Answered' }];
const box = 'block w-full rounded-md border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-ink-faint';

/** What the owner can send to his customer or accountant when he does not know: the question, what we do meanwhile, the choices. */
const noteFor = (d: DecisionCard) =>
  `Question: ${d.question}\n${d.whatWeDid ? `What we do for now: ${d.whatWeDid}\n` : d.why ? `Why we ask: ${d.why}\n` : ''}Choices: ${d.options.map((o, i) => `${i + 1}) ${o.label}`).join('  ')}\nPlease tell us which one fits, or how it works for you.`;

function Item({ d, open, onToggle, onChanged, onAsk }: { d: DecisionCard; open: boolean; onToggle: () => void; onChanged: (msg: string) => void; onAsk: (text: string) => void }) {
  const [choice, setChoice] = useState<string>(d.answer ?? '');
  const [note, setNote] = useState(d.note ?? '');
  const [who, setWho] = useState(d.statusNote ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState(false);
  const [copied, setCopied] = useState(false);
  const picked = d.options.find((o) => o.label === choice);
  const freeOnly = d.options.length === 1 && !!d.options[0]?.writeIn;

  const save = async () => {
    setErr(null); setBusy(true);
    const r = await answerDecisionAction({ decisionId: d.id, choice: freeOnly ? (d.options[0]?.label ?? choice) : choice, note });
    setBusy(false);
    if (r.ok) onChanged('Saved. Thank you.'); else setErr(r.message);
  };
  const move = async (status: 'LATER' | 'NEEDS_CLIENT' | 'OPEN', msg: string) => {
    setErr(null); setBusy(true);
    const r = await setDecisionStatusAction({ decisionId: d.id, status, note: status === 'NEEDS_CLIENT' ? who : undefined });
    setBusy(false);
    if (r.ok) onChanged(msg); else setErr(r.message);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(noteFor(d)); setCopied(true); } catch { setCopied(false); } };

  return (
    <li className="rounded-md border border-line bg-surface">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-h-14 w-full items-start gap-3 px-4 py-3 text-left">
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-ink-soft">{d.topic}</span>
          <span className="block font-medium">{d.question}</span>
          {d.status === 'ANSWERED' && <span className="mt-1 flex items-center gap-1 text-confirm"><Check aria-hidden className="size-4" />{d.answer}</span>}
        </span>
        <ChevronDown aria-hidden className={cn('mt-1 size-5 shrink-0 text-ink-soft transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-4 py-4">
          {d.whatWeDid && <p><span className="font-medium">What we did: </span>{d.whatWeDid}</p>}
          {d.why && <p><span className="font-medium">{d.whatWeDid ? 'Why: ' : 'Why it matters: '}</span>{d.why}</p>}
          {d.agreedByKasi && <p className="rounded-md bg-copper-wash px-3 py-2 text-copper-deep">Kasi has already agreed to this. Please say if you agree too.</p>}

          {!freeOnly && (
            <fieldset>
              <legend className="mb-1 font-medium">Your answer</legend>
              <div className="space-y-1">
                {d.options.map((o) => (
                  <label key={o.value} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-copper-wash">
                    <input type="radio" name={`ans-${d.id}`} value={o.label} checked={choice === o.label} onChange={() => setChoice(o.label)} className="size-5 accent-[var(--copper)]" />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {(picked?.writeIn || freeOnly) && (
            <div>
              <label htmlFor={`note-${d.id}`} className="font-medium">{freeOnly ? d.options[0]?.label : 'Say it in your own words'}</label>
              <textarea id={`note-${d.id}`} rows={3} value={note} onChange={(e) => setNote(e.target.value)} className={box} />
            </div>
          )}
          {!picked?.writeIn && !freeOnly && choice && (
            <div>
              <label htmlFor={`note-${d.id}`} className="font-medium">Anything to add? <span className="font-normal text-ink-soft">(you can leave it empty)</span></label>
              <textarea id={`note-${d.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={box} />
            </div>
          )}

          {err && <p role="alert" className="text-alert">{err}</p>}

          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy || (!freeOnly && !choice) || (freeOnly && !note.trim())} onClick={() => void save()}>{d.status === 'ANSWERED' ? 'Change my answer' : 'Save my answer'}</Button>
            {d.status !== 'LATER' && d.status !== 'ANSWERED' && <Button type="button" variant="secondary" disabled={busy} onClick={() => void move('LATER', 'Put aside for later.')}>Later</Button>}
            {d.status !== 'NEEDS_CLIENT' && <Button type="button" variant="secondary" disabled={busy} onClick={() => setClient((v) => !v)}>I don&apos;t know, ask the client</Button>}
            {d.status === 'LATER' || d.status === 'NEEDS_CLIENT' ? <Button type="button" variant="secondary" disabled={busy} onClick={() => void move('OPEN', 'Back in the list to answer.')}>Back to answer</Button> : null}
            <Button type="button" variant="secondary" onClick={() => onAsk(`Explain this question to me in simple words: ${d.question}`)}><MessageCircleQuestion aria-hidden className="size-4" />Ask the assistant about this</Button>
          </div>

          {(client || d.status === 'NEEDS_CLIENT') && (
            <div className="space-y-2 rounded-md border border-line bg-paper p-3">
              <label htmlFor={`who-${d.id}`} className="font-medium">Who will you ask? <span className="font-normal text-ink-soft">(optional)</span></label>
              <input id={`who-${d.id}`} value={who} onChange={(e) => setWho(e.target.value)} className={box} />
              <p className="font-medium">A note you can send them</p>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-surface p-3 font-sans text-base" aria-label="Note for the client">{noteFor(d)}</pre>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={() => void copy()}><ClipboardCopy aria-hidden className="size-4" />{copied ? 'Copied' : 'Copy the note'}</Button>
                {d.status !== 'NEEDS_CLIENT' && <Button type="button" disabled={busy} onClick={() => void move('NEEDS_CLIENT', 'Marked as waiting for the client.')}>Mark as waiting for the client</Button>}
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** The owner's questions: the ones to answer first, what waits for the client, what is for later, and what he already said. */
export function DecisionsPanel({ onAsk, onCounts }: { onAsk: (text: string) => void; onCounts?: (open: number) => void }) {
  const [data, setData] = useState<DecisionList | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<Tab>('OPEN');
  const [firstOnly, setFirstOnly] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [said, setSaid] = useState('');

  const load = useCallback(async () => {
    const r = await listDecisionsAction();
    if (!r.ok) { setFailed(true); return; }
    setData(r.data); onCounts?.(r.data.counts.firstPassToAnswer);
  }, [onCounts]);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    const all = (data?.rows ?? []).filter((d) => d.status === tab);
    return tab === 'OPEN' && firstOnly && (data?.counts.firstPassToAnswer ?? 0) > 0 ? all.filter((d) => d.firstPass) : all;
  }, [data, tab, firstOnly]);
  const groups = useMemo(() => [...new Set(rows.map((r) => r.topic))].map((t) => ({ topic: t, items: rows.filter((r) => r.topic === t) })), [rows]);

  if (failed) return <p role="alert">The questions are for the owner only.</p>;
  if (!data) return <p>Looking…</p>;
  const count = (t: Tab) => (t === 'OPEN' ? data.counts.toAnswer : t === 'NEEDS_CLIENT' ? data.counts.waitingForClient : t === 'LATER' ? data.counts.later : data.counts.answered);

  return (
    <div data-testid="decisions-panel" className="space-y-4">
      <p className="text-ink-soft">These are things only you can decide. Answer what you know. Put the rest aside, or ask the assistant about it.</p>
      <div role="tablist" aria-label="Questions" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => { setTab(t.id); setOpenId(null); }}
            className={cn('min-h-11 rounded-full border px-4 font-medium', tab === t.id ? 'border-copper bg-copper-wash text-copper-deep' : 'border-line bg-surface text-ink hover:bg-copper-wash')}>
            {t.label} <span className="num">({count(t.id)})</span>
          </button>
        ))}
      </div>
      {tab === 'OPEN' && data.counts.firstPassToAnswer > 0 && (
        <p className="flex flex-wrap items-center gap-2">
          {firstOnly ? `Showing the ${data.counts.firstPassToAnswer} to answer first.` : `Showing all ${data.counts.toAnswer}.`}
          <button type="button" onClick={() => setFirstOnly((v) => !v)} className="min-h-11 font-medium text-copper-deep underline">{firstOnly ? 'Show all of them' : 'Show the first ones only'}</button>
        </p>
      )}
      <p aria-live="polite" className="min-h-6 text-confirm">{said}</p>
      {groups.length === 0 && <p className="rounded-md border border-line bg-paper px-4 py-6 text-center text-ink-soft">{tab === 'OPEN' ? 'Nothing is waiting for you. Thank you.' : 'Nothing here.'}</p>}
      {groups.map((g) => (
        <section key={g.topic} aria-label={g.topic} className="space-y-2">
          <h3 className="font-display text-lg font-bold">{g.topic}</h3>
          <ul className="space-y-2">
            {g.items.map((d) => (
              <Item key={`${d.id}:${d.status}:${d.answeredAt ?? ''}`} d={d} open={openId === d.id} onToggle={() => setOpenId(openId === d.id ? null : d.id)} onAsk={onAsk}
                onChanged={(m) => { setSaid(m); setOpenId(null); void load(); }} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
