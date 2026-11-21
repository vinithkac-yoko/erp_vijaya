'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Paperclip, Send, Square, X } from 'lucide-react';
import type { ChatItem, Chip } from '@/lib/cards';
import type { Launcher } from '@/lib/launcher/launcher';
import { openFormAction } from '@/server/chat/actions';
import type { ChatEvent } from '@/server/agent/events';
import { redactSecrets } from '@/server/agent/redact'; // pure text function: safe in the browser
import { LauncherRow } from '@/components/shell/launcher';
import { cn } from '@/lib/cn';
import { openArtifactFormAction } from '@/server/artifacts/actions';
import { ArtifactCard, AssistantText, DownloadCard, NoticeCard, OpeningCard, PrintoutCard, SavedCard, TableCard } from './cards';
import { FormCard } from './form-card';
import { VoiceButton } from './voice-button';

export interface ChatViewProps {
  initialItems: ChatItem[];
  conversationId: string | null;
  launcher: Launcher;
  formEnabled: Record<string, boolean>;
  chipEnabled: Record<string, boolean>;
  badges: { pendingApprovals: number; belowMinimum: number };
  assistantOn: boolean;
  offMessage: string;
  /** The microphone button shows only when listening is set up on the server. */
  voiceOn?: boolean;
  /** Owner only: the paperclip. A file is checked on the server again; this only decides whether the button is drawn. */
  filesOn?: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** The shell calls this with a function that opens a form (for Alt+R, the Share button and friends). */
  registerOpenForm: (fn: (tool: string, prefill?: Record<string, unknown>) => void) => void;
  /** Opens the count sheet in the panel. */
  onOpenSheet: () => void;
  /** Owner only: opens the Decisions panel. */
  onOpenDecisions: () => void;
  /** Lets the shell put a question to the assistant as if it were typed (the panel's "Ask the assistant about this"). */
  registerAsk: (fn: (text: string) => void) => void;
  /** Opens an artifact, or a printout, beside the chat. */
  onOpenArtifact: (id: string) => void;
  onOpenPrintout: (card: Extract<import('@/lib/cards').Card, { kind: 'printout' }>) => void;
  /** The artifact open beside the chat: "change it" and "download it" mean this one. */
  openArtifactId: string | null;
  /** The shell calls this with a function that opens a tool's form from inside an artifact (a row button). */
  registerArtifactForm: (fn: (artifactId: string, tool: string, prefill: Record<string, unknown>) => Promise<void>) => void;
}

/** A file chosen in the composer: being read, ready to send, or refused (and then it is gone with its reason shown). */
interface Attached { key: string; name: string; id?: string; state: 'reading' | 'ready' }
const ACCEPT = '.xlsx,.csv,.docx,.txt,.pdf,.png,.jpg,.jpeg,.webp,.gif';

const NOTICE = (text: string): ChatItem => ({ id: `n-${Date.now()}-${Math.random()}`, role: 'card', card: { kind: 'notice', tone: 'info', text } });

export function ChatView(p: ChatViewProps) {
  const [items, setItems] = useState<ChatItem[]>(p.initialItems);
  const [conversationId, setConversationId] = useState<string | null>(p.conversationId);
  const [chips, setChips] = useState<Chip[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [newForm, setNewForm] = useState<string | null>(null);
  const [files, setFiles] = useState<Attached[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const convRef = useRef(conversationId);
  convRef.current = conversationId;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const artifactRef = useRef(p.openArtifactId);
  artifactRef.current = p.openArtifactId;
  const open = useRef({ artifact: p.onOpenArtifact, printout: p.onOpenPrintout });
  open.current = { artifact: p.onOpenArtifact, printout: p.onOpenPrintout };

  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [items, status, chips]);

  const adopt = useCallback((id: string) => {
    setConversationId(id);
    // Only the address bar changes (so a reload or a bookmark finds this chat). Next's own replaceState would also ask the
    // server to draw the page again, and a page drawn again starts this view over: a half-typed form would be lost.
    if (typeof window !== 'undefined' && new URL(window.location.href).searchParams.get('c') !== id) History.prototype.replaceState.call(window.history, window.history.state, '', `/?c=${id}`);
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
      // What the person asked for opens beside the chat, unless they are in the middle of a form (the card is there to tap).
      const c = e.item.role === 'card' ? e.item.card : null;
      const formOpen = itemsRef.current.some((x) => x.role === 'card' && x.card.kind === 'form' && x.state === 'open');
      if (c && c.kind === 'artifact' && c.open && !formOpen) open.current.artifact(c.artifactId);
      if (c && c.kind === 'printout' && c.open && !formOpen) open.current.printout(c);
      setItems((cur) => [...cur, e.item]);
    } else if (e.type === 'chips') setChips(e.chips);
  }, [adopt]);

  const filesRef = useRef(files);
  filesRef.current = files;
  const send = useCallback(async (message: string, chip?: string) => {
    const attached = filesRef.current.filter((f) => f.state === 'ready' && f.id);
    // files with no words: say what to do with them
    const msg = message.trim() || (attached.length ? `I attached ${attached.length === 1 ? 'a file' : `${attached.length} files`}. Please look at ${attached.length === 1 ? 'it' : 'them'} and tell me what you find.` : '');
    if (!msg || busy || filesRef.current.some((f) => f.state === 'reading')) return;
    setChips([]); setBusy(true); setStatus('Working on it…'); setText(''); setFiles([]); setFileError(null);
    // the opening card stays; the person's words join the chat
    // (a password typed here is shown hidden, the same as it is kept)
    setItems((cur) => [...cur, { id: `u-${Date.now()}`, role: 'user', text: redactSecrets(msg).text, ...(attached.length ? { uploads: attached.map((f) => ({ name: f.name, kind: '' })) } : {}) }]);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal, body: JSON.stringify({ conversationId: convRef.current, message: msg, chip, artifactId: artifactRef.current, ...(attached.length ? { uploadIds: attached.map((f) => f.id) } : {}) }) });
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

  /** Sends each chosen file to the server, which checks it and reads it; the chip shows "Reading…" until then. */
  const attach = useCallback(async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setFileError(null);
    for (const file of Array.from(list).slice(0, 6)) {
      const key = `f-${Date.now()}-${Math.random()}`;
      setFiles((cur) => [...cur, { key, name: file.name, state: 'reading' }]);
      try {
        const body = new FormData();
        body.set('file', file);
        if (convRef.current) body.set('conversationId', convRef.current);
        const res = await fetch('/api/uploads', { method: 'POST', body, credentials: 'same-origin' });
        const data = (await res.json().catch(() => null)) as { upload?: { id: string }; error?: string } | null;
        if (!res.ok || !data?.upload) throw new Error(res.status === 401 ? 'Please log in again.' : data?.error ?? "I couldn't take that file. Please try again.");
        setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, id: data.upload!.id, state: 'ready' } : f)));
      } catch (e) {
        setFiles((cur) => cur.filter((f) => f.key !== key));
        setFileError(`${file.name}: ${(e as Error).message}`);
      }
    }
    if (picker.current) picker.current.value = '';
  }, []);

  const openForm = useCallback(async (tool: string, prefill?: Record<string, unknown>) => {
    setChips([]);
    const r = await openFormAction({ tool, conversationId: convRef.current, prefill });
    if (!r.ok) { setItems((cur) => [...cur, NOTICE(r.message)]); return; }
    if (r.sheet) { p.onOpenSheet(); return; }
    adopt(r.conversationId);
    const form = r.items.at(-1);
    if (form) setNewForm(form.id);
    setItems((cur) => (r.created ? r.items : [...cur, ...r.items]));
  }, [adopt, p]);

  useEffect(() => { p.registerOpenForm((tool, prefill) => { void openForm(tool, prefill); }); }, [p, openForm]);
  useEffect(() => { p.registerAsk((m) => void send(m)); }, [p, send]);

  // A row button inside an artifact: the tool's own form opens in the chat, filled in with what the row says (never a rate).
  const openFromArtifact = useCallback(async (artifactId: string, tool: string, prefill: Record<string, unknown>) => {
    const r = await openArtifactFormAction({ artifactId, tool, prefill, conversationId: convRef.current });
    if (!r.ok) { setItems((cur) => [...cur, NOTICE(r.message)]); return; }
    adopt(r.conversationId);
    const form = r.items.at(-1);
    if (form) setNewForm(form.id);
    setItems((cur) => (r.created ? r.items : [...cur, ...r.items]));
  }, [adopt]);
  useEffect(() => { p.registerArtifactForm(openFromArtifact); }, [p, openFromArtifact]);

  const closeForm = (id: string, state: 'saved' | 'closed', extra: ChatItem[]) =>
    setItems((cur) => [...cur.map((x) => (x.id === id && x.role === 'card' ? { ...x, state } : x)), ...extra]);

  const composerOff = !p.assistantOn;
  const last = items.at(-1);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" role="log" aria-label="Chat" aria-live="polite" aria-relevant="additions">
        <div className="mx-auto w-full max-w-[720px] space-y-4 px-4 py-5 md:py-8">
          {items.map((it) => {
            if (it.role === 'user') {
              return (
                <div key={it.id} className="flex flex-col items-end gap-1.5">
                  {it.uploads && it.uploads.length > 0 && (
                    <ul aria-label="Attached files" className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
                      {it.uploads.map((u, i) => <li key={i} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-sm text-ink-soft"><FileText aria-hidden className="size-4 shrink-0" /><span className="truncate">{u.name}</span></li>)}
                    </ul>
                  )}
                  <p className="max-w-[85%] whitespace-pre-wrap rounded-md bg-plate px-4 py-2.5 text-plate-ink">{it.text}</p>
                </div>
              );
            }
            if (it.role === 'assistant') return <AssistantText key={it.id} text={it.text} />;
            const c = it.card;
            if (c.kind === 'opening') return <OpeningCard key={it.id} card={c} assistantOn={p.assistantOn} onAsk={(ask, label) => void send(ask, label)} onSheet={p.onOpenSheet} onDecisions={p.onOpenDecisions} onForm={(tool, prefill) => void openForm(tool, prefill)} />;
            if (c.kind === 'table') return <TableCard key={it.id} card={c} />;
            if (c.kind === 'notice') return <NoticeCard key={it.id} card={c} />;
            if (c.kind === 'saved') return <SavedCard key={it.id} card={c} />;
            if (c.kind === 'artifact') return <ArtifactCard key={it.id} card={c} onOpen={p.onOpenArtifact} />;
            if (c.kind === 'printout') return <PrintoutCard key={it.id} card={c} onOpen={p.onOpenPrintout} />;
            if (c.kind === 'download') return <DownloadCard key={it.id} card={c} />;
            return (
              <FormCard key={it.id} pendingId={c.pendingId} tool={c.tool} form={c.form} values={c.values} assisted={c.assisted} info={c.info} state={it.state ?? 'closed'}
                conversationId={conversationId} focusOnMount={newForm === it.id}
                onSaved={(extra, nextChips) => { closeForm(it.id, 'saved', extra); setChips(nextChips); }}
                onClosed={(extra) => closeForm(it.id, 'closed', extra)}
                onSwitched={(extra) => { const f = extra.find((x) => x.role === 'card' && x.card.kind === 'form'); if (f) setNewForm(f.id); closeForm(it.id, 'closed', extra); }} />
            );
          })}
          {status && <p className="flex items-center gap-2 text-ink-soft" role="status"><span aria-hidden className="size-2 animate-pulse rounded-full bg-copper" />{status}</p>}
          {chips.length > 0 && !busy && (
            <div className="flex flex-wrap gap-2" aria-label="Suggestions">
              {chips.map((c) => (
                <button key={c.label} type="button" onClick={() => ('ask' in c ? void send(c.ask) : 'sheet' in c ? p.onOpenSheet() : void openForm(c.form, c.prefill))}
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
          {(files.length > 0 || fileError) && (
            <div className="space-y-1.5">
              {files.length > 0 && (
                <ul aria-label="Files to send" className="flex flex-wrap gap-1.5">
                  {files.map((f) => (
                    <li key={f.key} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface py-1 pl-3 pr-1 text-sm">
                      <FileText aria-hidden className="size-4 shrink-0 text-ink-soft" />
                      <span className="truncate">{f.name}</span>
                      {f.state === 'reading' ? <span role="status" className="px-1 text-ink-soft">Reading…</span>
                        : <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.key !== f.key))} className="inline-flex size-7 items-center justify-center rounded-full hover:bg-copper-wash"><X aria-hidden className="size-4" /></button>}
                    </li>
                  ))}
                </ul>
              )}
              {fileError && <p role="alert" className="text-alert">{fileError}</p>}
            </div>
          )}
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
            {p.filesOn && (
              <>
                <input ref={picker} type="file" multiple accept={ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void attach(e.target.files)} data-testid="file-input" />
                <button type="button" aria-label="Attach a file" disabled={composerOff || busy} onClick={() => picker.current?.click()}
                  className="inline-flex size-12 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink hover:bg-copper-wash disabled:cursor-not-allowed disabled:opacity-50"><Paperclip aria-hidden className="size-5" /></button>
              </>
            )}
            <label htmlFor="chat-input" className="sr-only">Type a message</label>
            <textarea id="chat-input" ref={p.inputRef} rows={1} disabled={composerOff} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000}
              placeholder={composerOff ? p.offMessage : 'Ask a question, or say what you want to do…'}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); } }}
              className="min-h-12 flex-1 resize-none rounded-md border border-line bg-surface px-3 py-3 text-base text-ink placeholder:text-ink-soft disabled:cursor-not-allowed" />
            {/* what is said lands in the box, to be read and changed; it is sent only when the person presses Send */}
            {p.voiceOn && <VoiceButton disabled={composerOff || busy} onText={(t) => { setText((cur) => (cur.trim() ? `${cur.trim()} ${t}` : t).slice(0, 2000)); p.inputRef.current?.focus(); }} />}
            {busy ? (
              <button type="button" aria-label="Stop" onClick={() => abort.current?.abort()}
                className="inline-flex size-12 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink hover:bg-copper-wash"><Square aria-hidden className="size-5" /></button>
            ) : (
              <button type="submit" aria-label="Send" disabled={composerOff || (!text.trim() && !files.some((f) => f.state === 'ready')) || files.some((f) => f.state === 'reading')}
                className={cn('inline-flex size-12 shrink-0 items-center justify-center rounded-md border border-copper bg-copper text-on-copper', 'disabled:cursor-not-allowed disabled:opacity-50')}><Send aria-hidden className="size-5" /></button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
