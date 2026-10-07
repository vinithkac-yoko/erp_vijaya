'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, History, RefreshCw, Share2, Star, Trash2 } from 'lucide-react';
import { artifactFormsFor, readToolsFor, type Role } from '@/lib/catalog';
import { dateText, timeText } from '@/lib/format';
import { cn } from '@/lib/cn';
import { mountArtifact, needsMermaid } from '@/lib/artifacts/host/host.js';
import { archiveArtifactAction, artifactReadAction, loadArtifactAction, restoreVersionAction, saveArtifactAction, type LoadedArtifact } from '@/server/artifacts/actions';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { saveFile } from '@/components/chat/cards';

interface Assets { tokensCss: string; bootstrapSource: string; uiKitSource: string; vdocSource: string; docRenderSource: string }
let assetsPromise: Promise<Assets> | undefined;
let mermaidPromise: Promise<string> | undefined;
const loadAssets = () => (assetsPromise ??= fetch('/api/artifacts/assets', { credentials: 'same-origin' }).then((r) => { if (!r.ok) throw new Error('assets'); return r.json() as Promise<Assets>; }).catch((e) => { assetsPromise = undefined; throw e; }));
const loadMermaid = () => (mermaidPromise ??= fetch('/api/artifacts/mermaid', { credentials: 'same-origin' }).then((r) => { if (!r.ok) throw new Error('mermaid'); return r.text(); }).catch((e) => { mermaidPromise = undefined; throw e; }));

/**
 * The nonce of THIS document's security policy. After a login the page is drawn by a soft navigation, so the nonce the server
 * passed down belongs to a newer request than the one whose policy the browser is enforcing; the scripts Next put in the
 * document carry the right one (the attribute is hidden from script, the property is not).
 */
const documentNonce = (fallback: string) => document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce || fallback;

const currentTheme = (): 'light' | 'dark' => {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
};

const bar = 'inline-flex min-h-11 md:min-h-9 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-base font-medium text-ink hover:bg-copper-wash disabled:cursor-not-allowed disabled:opacity-60 data-[state=open]:bg-copper-wash';

export interface ArtifactPanelProps {
  id: string;
  nonce: string;
  role: Role;
  /** A row button or openForm inside the artifact: the shell opens the tool's own form in the chat. */
  onOpenForm: (artifactId: string, tool: string, prefill: Record<string, unknown>) => Promise<void>;
  /** The owner pressed Share (or Stop sharing): the shell opens that form in the chat. */
  onShare: (artifactId: string, version: number, stop: boolean) => void;
  onClosed: () => void;
  /** Tells the shell the title and version, so the panel header and the chat know what is open. */
  onLoaded?: (title: string) => void;
}

export function ArtifactPanel({ id, nonce, role, onOpenForm, onShare, onClosed, onLoaded }: ArtifactPanelProps) {
  const [data, setData] = useState<LoadedArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const formRef = useRef(onOpenForm);
  formRef.current = onOpenForm;

  const load = useCallback(async () => {
    const r = await loadArtifactAction({ id });
    if (!r.ok) { setError(r.message); return; }
    setError(null); setData(r.artifact); onLoaded?.(r.artifact.title);
  }, [id, onLoaded]);
  useEffect(() => { setData(null); setError(null); setNote(null); void load(); }, [load]);

  // Mount the sandbox. A new version, or Refresh, mounts it again: the numbers are read fresh each time.
  useEffect(() => {
    if (!data || !box.current) return;
    let handle: ReturnType<typeof mountArtifact> | undefined;
    let dead = false;
    (async () => {
      try {
        const [assets, mermaid] = await Promise.all([loadAssets(), data.kind === 'document' && needsMermaid(data.source) ? loadMermaid() : Promise.resolve(undefined)]);
        if (dead || !box.current) return;
        box.current.replaceChildren();
        handle = mountArtifact({
          container: box.current, kind: data.kind, ...(data.kind === 'document' ? { source: data.source } : { html: data.source }), ...assets, mermaidSource: mermaid, theme: currentTheme(), nonce: documentNonce(nonce),
          user: { role }, title: data.title, allowedRead: new Set(readToolsFor(role)), allowedWrite: new Set(artifactFormsFor(role)),
          runRead: async (tool: string, input: unknown) => { const r = await artifactReadAction({ artifactId: data.id, tool, input }); if (!r.ok) throw new Error(r.message); return r.data; },
          onOpenForm: async (tool: string, prefill: Record<string, unknown>) => { await formRef.current(data.id, tool, prefill); },
          onEvent: (e: { type: string }) => { if (e.type === 'navigated-away' || e.type === 'flood-killed') setError('This was stopped because it did not behave. Ask for it again.'); },
        });
        handle.iframe.style.flex = '1 1 0'; handle.iframe.style.height = 'auto'; handle.iframe.style.minHeight = '0';
        // The footer is drawn by the host (the artifact cannot reach it); here it takes the app's own colours, light and dark.
        handle.footer.style.cssText = ''; handle.footer.className = 'shrink-0 border-t border-line bg-surface px-3 py-1.5 text-sm text-ink-faint';
      } catch { if (!dead) setError("Couldn't load that. Try again."); }
    })();
    return () => { dead = true; handle?.destroy(); };
  }, [data, run, nonce, role]);

  const download = async (format: string) => {
    if (!data) return;
    setBusy(format); setNote(null);
    const e = await saveFile(`/api/artifacts/${data.id}/download?format=${format}`);
    setBusy(null); setNote(e);
  };
  const toggleSave = async () => {
    if (!data) return;
    const r = await saveArtifactAction({ id: data.id, saved: !data.saved });
    if (r.ok) setData({ ...data, saved: r.saved }); else setNote(r.message);
  };
  const restore = async (n: number) => { if (!data) return; const r = await restoreVersionAction({ id: data.id, n }); if (r.ok) { setNote(`Went back to version ${n}. It is now version ${r.version}.`); await load(); } else setNote(r.message); };
  const remove = async () => {
    if (!data || !window.confirm('Delete this from your list? Nothing else is lost.')) return;
    const r = await archiveArtifactAction({ id: data.id });
    if (r.ok) onClosed(); else setNote(r.message);
  };
  const share = () => { if (!data) return; if (!data.canShare.ok) { setNote(data.canShare.reason ?? "This can't be shared."); return; } onShare(data.id, data.version, false); };

  if (error && !data) return <div className="p-4"><p role="alert" className="text-alert">{error}</p><button type="button" onClick={() => void load()} className={cn(bar, 'mt-3')}>Try again</button></div>;
  if (!data) return <p className="p-4 text-ink-soft" role="status">Opening…</p>;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="artifact-panel">
      <div className="shrink-0 border-b border-line px-3 py-2">
        {!data.owned && <p className="mb-2 text-sm text-ink-soft">Shared by {data.sharedBy} · version {data.version}{data.sharedAt ? ` · ${dateText(new Date(data.sharedAt))}` : ''}</p>}
        {data.owned && data.sharedWithStorekeeper && <p className="mb-2 text-sm text-ink-soft">The storekeeper has a copy of an earlier version.</p>}
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Artifact tools">
          <button type="button" className={bar} onClick={() => { setNote(null); setRun((n) => n + 1); }}><RefreshCw aria-hidden className="size-4" />Refresh</button>

          {data.owned ? (
            <DropdownMenu>
              <DropdownMenuTrigger className={bar}><History aria-hidden className="size-4" />Version {data.version}<ChevronDown aria-hidden className="size-4" /></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-80">
                <DropdownMenuLabel>Earlier versions stay. Restoring one makes a new version.</DropdownMenuLabel>
                {data.versions.map((v) => (
                  <DropdownMenuItem key={v.n} disabled={v.n === data.version} onSelect={() => void restore(v.n)} className="flex-col items-start gap-0 py-1">
                    <span className="font-medium">v{v.n} · {dateText(new Date(v.at))} {timeText(new Date(v.at))}{v.n === data.version ? ' · now' : ''}</span>
                    <span className="max-w-full truncate text-sm text-ink-soft">{v.restored ? v.summary : v.request}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : <span className="px-1 text-ink-soft">Version {data.version}</span>}

          {data.owned && (
            <button type="button" className={bar} aria-pressed={data.saved} onClick={() => void toggleSave()}>
              <Star aria-hidden className={cn('size-4', data.saved && 'fill-copper text-copper')} />{data.saved ? 'Saved' : 'Save'}
            </button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger className={bar} disabled={!!busy}><Download aria-hidden className="size-4" />{busy ? 'Preparing…' : 'Download'}<ChevronDown aria-hidden className="size-4" /></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {data.formats.map((f) => (
                <DropdownMenuItem key={f.format} disabled={!f.ok} onSelect={() => void download(f.format)} className="min-h-12 md:min-h-9">
                  {f.label}{!f.ok && f.why ? <span className="text-sm text-ink-faint"> — {f.why}</span> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {data.owned && role === 'OWNER' && <button type="button" className={bar} onClick={share}><Share2 aria-hidden className="size-4" />{data.sharedWithStorekeeper ? 'Share this version' : 'Share'}</button>}
          {data.owned && role === 'OWNER' && data.sharedWithStorekeeper && <button type="button" className={bar} onClick={() => onShare(data.id, data.version, true)}>Stop sharing</button>}
          {data.owned && (
            <DropdownMenu>
              <DropdownMenuTrigger className={cn(bar, 'px-2')} aria-label="More"><ChevronDown aria-hidden className="size-4" /></DropdownMenuTrigger>
              <DropdownMenuContent align="end"><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => void remove()}><Trash2 aria-hidden className="size-4" />Delete</DropdownMenuItem></DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {(note || error) && <p role="status" className="mt-2 text-ink-soft">{error ?? note}</p>}
      </div>
      <div ref={box} className="flex min-h-0 flex-1 flex-col" />
    </div>
  );
}
