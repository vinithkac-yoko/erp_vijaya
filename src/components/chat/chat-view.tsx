'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';
import type { ChatItem, Chip } from '@/lib/cards';
import type { Launcher } from '@/lib/launcher/launcher';
import { openFormAction } from '@/server/chat/actions';
import type { ChatEvent } from '@/server/agent/events';
import { redactSecrets } from '@/server/agent/redact'; // pure text function: safe in the browser
import { LauncherRow } from '@/components/shell/launcher';
import { cn } from '@/lib/cn';
import { NoticeCard, OpeningCard, SavedCard, TableCard } from './cards';
import { FormCard } from './form-card';

export interface ChatViewProps {
  initialItems: ChatItem[];
  conversationId: string | null;
  launcher: Launcher;
  formEnabled: Record<string, boolean>;
  chipEnabled: Record<string, boolean>;
  badges: { pendingApprovals: number; belowMinimum: number };
  assistantOn: boolean;
  offMessage: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** The shell calls this with a function that opens a form (for Alt+R and friends). */
  registerOpenForm: (fn: (tool: string) => void) => void;
}

const NOTICE = (text: string): ChatItem => ({ id: `n-${Date.now()}-${Math.random()}`, role: 'card', card: { kind: 'notice', tone: 'info', text } });

export function ChatView(p: ChatViewProps) {
  const [items, setItems] = useState<ChatItem[]>(p.initialItems);
  const [conversationId, setConversationId] = useState<string | null>(p.conversationId);
  const [chips, setChips] = useState<Chip[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [newForm, setNewForm] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const convRef = useRef(conversationId);
  convRef.current = conversationId;

  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [items, status, chips]);

  const adopt = useCallback((id: string) => {
    setConversationId(id);
    if (typeof window !== 'undefined' && new URL(window.location.href).searchParams.get('c') !== id) window.history.replaceState(null, '', `/?c=${id}`);
  }, []);

  const handle = useCallback((e: ChatEvent) => {
    if (e.type === 'conversation') adopt(e.id);
    else if (e.type === 'status') setStatus(e.text);
    else if (e.type === 'text') {
      setStatus(null);
      setItems((cur) => {
        const id = `a:${e.id}`;
        const i = cur.findIndex((x) => x.id === id);
        if (i < 0) return [...cur, { id, role: 'assistant', text: e.delta }];
        const next = [...cur];
        const it = next[i] as Extract<ChatItem, { role: 'assistant' }>;
        next[i] = { ...it, text: it.text + e.delta };
        return next;
      });
    } else if (e.type === 'item') {
      setStatus(null);
      if (e.item.role === 'card' && e.item.card.kind === 'form') setNewForm(e.item.id);
      setItems((cur) => [...cur, e.item]);
    } else if (e.type === 'chips') setChips(e.chips);
  }, [adopt]);

  const send = useCallback(async (message: string, chip?: string) => {
    const msg = message.trim();
    if (!msg || busy) return;
    setChips([]); setBusy(true); setStatus('Working on it…'); setText('');
    // the opening card stays; the person's words join the chat
    // (a password typed here is shown hidden, the same as it is kept)
    setItems((cur) => [...cur, { id: `u-${Date.now()}`, role: 'user', text: redactSecrets(msg).text }]);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal, body: JSON.stringify({ conversationId: convRef.current, message: msg, chip }) });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null;
        setItems((cur) => [...cur, NOTICE(res.status === 401 ? 'Please log in again.' : err?.error ?? "I can't answer right now. The buttons above still work.")]);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handle(JSON.parse(line) as ChatEvent);
        }
      }
    } catch (err) {
      setItems((cur) => [...cur, NOTICE((err as Error)?.name === 'AbortError' ? 'Stopped.' : "The connection dropped. Nothing was saved. Please try again.")]);
    } finally {
      setBusy(false); setStatus(null); abort.current = null;
    }
  }, [busy, handle]);

  const openForm = useCallback(async (tool: string) => {
    setChips([]);
    const r = await openFormAction({ tool, conversationId: convRef.current });
    if (!r.ok) { setItems((cur) => [...cur, NOTICE(r.message)]); return; }
    adopt(r.conversationId);
    const form = r.items.at(-1);
    if (form) setNewForm(form.id);
    setItems((cur) => (r.created ? r.items : [...cur, ...r.items]));
  }, [adopt]);

  useEffect(() => { p.registerOpenForm((tool) => { void openForm(tool); }); }, [p, openForm]);

  const closeForm = (id: string, state: 'saved' | 'closed', extra: ChatItem[]) =>
    setItems((cur) => [...cur.map((x) => (x.id === id && x.role === 'card' ? { ...x, state } : x)), ...extra]);

  const composerOff = !p.assistantOn;
  const last = items.at(-1);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" role="log" aria-label="Chat" aria-live="polite" aria-relevant="additions">
        <div className="mx-auto w-full max-w-[720px] space-y-4 px-4 py-5 md:py-8">
          {items.map((it) => {
            if (it.role === 'user') return <div key={it.id} className="flex justify-end"><p className="max-w-[85%] whitespace-pre-wrap rounded-md bg-plate px-4 py-2.5 text-plate-ink">{it.text}</p></div>;
            if (it.role === 'assistant') return <p key={it.id} className="whitespace-pre-wrap rounded-md border border-line border-l-4 border-l-copper bg-surface px-4 py-3">{it.text}</p>;
            const c = it.card;
            if (c.kind === 'opening') return <OpeningCard key={it.id} card={c} assistantOn={p.assistantOn} onAsk={(ask, label) => void send(ask, label)} />;
            if (c.kind === 'table') return <TableCard key={it.id} card={c} />;
            if (c.kind === 'notice') return <NoticeCard key={it.id} card={c} />;
            if (c.kind === 'saved') return <SavedCard key={it.id} card={c} />;
            return (
              <FormCard key={it.id} pendingId={c.pendingId} tool={c.tool} form={c.form} values={c.values} assisted={c.assisted} state={it.state ?? 'closed'}
                conversationId={conversationId} focusOnMount={newForm === it.id}
                onSaved={(extra, nextChips) => { closeForm(it.id, 'saved', extra); setChips(nextChips); }}
                onClosed={(extra) => closeForm(it.id, 'closed', extra)} />
            );
          })}
          {status && <p className="flex items-center gap-2 text-ink-soft" role="status"><span aria-hidden className="size-2 animate-pulse rounded-full bg-copper" />{status}</p>}
          {chips.length > 0 && !busy && (
            <div className="flex flex-wrap gap-2" aria-label="Suggestions">
              {chips.map((c) => (
                <button key={c.label} type="button" onClick={() => ('ask' in c ? void send(c.ask) : void openForm(c.form))}
                  className="inline-flex min-h-11 md:min-h-9 items-center rounded-full border border-line bg-copper-wash px-4 text-base hover:border-copper">{c.label}</button>
              ))}
            </div>
          )}
          {last?.role === 'card' && last.card.kind === 'form' && last.state === 'open' && null}
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-paper">
        <div className="mx-auto w-full max-w-[720px] space-y-3 px-4 py-3">
          <LauncherRow launcher={p.launcher} formEnabled={p.formEnabled} chipEnabled={p.chipEnabled} badges={p.badges}
            onForm={(tool) => void openForm(tool)} onChip={(label, ask) => void send(ask, label)} />
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
            <label htmlFor="chat-input" className="sr-only">Type a message</label>
            <textarea id="chat-input" ref={p.inputRef} rows={1} disabled={composerOff} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000}
              placeholder={composerOff ? p.offMessage : 'Ask a question, or say what you want to do…'}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); } }}
              className="min-h-12 flex-1 resize-none rounded-md border border-line bg-surface px-3 py-3 text-base text-ink placeholder:text-ink-soft disabled:cursor-not-allowed" />
            {busy ? (
              <button type="button" aria-label="Stop" onClick={() => abort.current?.abort()}
                className="inline-flex size-12 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink hover:bg-copper-wash"><Square aria-hidden className="size-5" /></button>
            ) : (
              <button type="submit" aria-label="Send" disabled={composerOff || !text.trim()}
                className={cn('inline-flex size-12 shrink-0 items-center justify-center rounded-md border border-copper bg-copper text-on-copper', 'disabled:cursor-not-allowed disabled:opacity-50')}><Send aria-hidden className="size-5" /></button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
