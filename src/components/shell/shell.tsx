'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { shortcutTool, type FormButton } from '@/lib/launcher/launcher';
import { ChatView, type ChatViewProps } from '@/components/chat/chat-view';
import { TopBar, type ChatLink, type ShellUser } from './top-bar';
import { Panel } from './panel';
import { Shortcuts } from './shortcuts';
import { CountSheet } from './count-sheet';
import { ArtifactPanel } from '@/components/artifacts/artifact-panel';
import { PrintoutPanel } from '@/components/artifacts/printout-panel';
import type { Card } from '@/lib/cards';

type PanelView = { kind: 'shortcuts' } | { kind: 'sheet' } | { kind: 'artifact'; id: string; title: string; rev: number } | { kind: 'printout'; template: string; ref: Record<string, string>; title: string } | null;

function typingInField(t: EventTarget | null) {
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

export interface ShellProps {
  user: ShellUser;
  chats: ChatLink[];
  currentChatId: string | null;
  allForms: FormButton[];
  chat: Omit<ChatViewProps, 'inputRef' | 'registerOpenForm' | 'onOpenSheet' | 'onOpenArtifact' | 'onOpenPrintout' | 'openArtifactId' | 'registerArtifactForm'>;
  /** The page's security nonce: the artifact frame's own scripts carry it (docs/ARTIFACTS.md §12). */
  nonce: string;
  /** Changes when another chat is opened (or a new one begun), so the chat view starts from what the server drew. */
  viewKey: string;
}

export function Shell({ user, chats, currentChatId, allForms, chat, viewKey, nonce }: ShellProps) {
  const [panel, setPanel] = useState<PanelView>(null);
  // The report last opened in this chat stays "the one we are talking about" after the panel (or a phone's full-screen sheet) is closed.
  const [contextArtifact, setContextArtifact] = useState<string | null>(null);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const openForm = useRef<(tool: string, prefill?: Record<string, unknown>) => void>(() => {});
  const artifactForm = useRef<(artifactId: string, tool: string, prefill: Record<string, unknown>) => Promise<void>>(async () => {});
  const close = useCallback(() => setPanel(null), []);
  const register = useCallback((fn: (tool: string, prefill?: Record<string, unknown>) => void) => { openForm.current = fn; }, []);
  const registerArtifact = useCallback((fn: (artifactId: string, tool: string, prefill: Record<string, unknown>) => Promise<void>) => { artifactForm.current = fn; }, []);
  // Opening it again (a new version was just made) loads it afresh: `rev` changes, so the panel starts over with the newest version.
  const openArtifact = useCallback((id: string, title = 'Opening…') => { setContextArtifact(id); setPanel((cur) => ({ kind: 'artifact', id, title: cur?.kind === 'artifact' && cur.id === id ? cur.title : title, rev: cur?.kind === 'artifact' && cur.id === id ? cur.rev + 1 : 0 })); }, []);
  const openPrintout = useCallback((c: Extract<Card, { kind: 'printout' }>) => setPanel({ kind: 'printout', template: c.template, ref: c.ref, title: c.title }), []);
  const retitle = useCallback((title: string) => setPanel((cur) => (cur && (cur.kind === 'artifact' || cur.kind === 'printout') ? { ...cur, title } : cur)), []);
  // A row button inside an artifact opens the tool's form in the chat; on a phone the panel covers the chat, so it steps aside.
  const formFromArtifact = useCallback(async (artifactId: string, tool: string, prefill: Record<string, unknown>) => {
    await artifactForm.current(artifactId, tool, prefill);
    if (window.matchMedia('(max-width: 767px)').matches) setPanel(null);
  }, []);
  const shareForm = useCallback((artifactId: string, version: number, stop: boolean) => {
    openForm.current(stop ? 'unshare_artifact' : 'share_artifact', stop ? { artifactId } : { artifactId, version });
    if (window.matchMedia('(max-width: 767px)').matches) setPanel(null);
  }, []);

  // Lets tests (and nobody else) know the page has finished loading and keys will be heard.
  useEffect(() => { document.body.dataset.ready = 'true'; }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (panel) { e.preventDefault(); close(); } return; }
      // Alt+R, Alt+I… belong to the tool, not to where its button sits (INTERFACE §3, §10). The physical key, so any layout works.
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^Key[A-Z]$/.test(e.code)) {
        const tool = shortcutTool(user.role, e.code.slice(3));
        if (tool) { e.preventDefault(); if (chat.formEnabled[tool]) openForm.current(tool); }
        return;
      }
      if (typingInField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); chatInput.current?.focus(); }
      else if (e.key === '?') { e.preventDefault(); setPanel({ kind: 'shortcuts' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, close, user.role, chat.formEnabled]);

  return (
    <div className="flex h-dvh flex-col">
      <TopBar user={user} chats={chats} currentChatId={currentChatId} onHelp={() => setPanel({ kind: 'shortcuts' })} onOpenArtifact={openArtifact} onSettings={user.role === 'OWNER' ? () => openForm.current('update_setting') : undefined} />
      <div className="relative flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col xl:min-w-[420px]">
          <ChatView key={viewKey} {...chat} inputRef={chatInput} registerOpenForm={register} onOpenSheet={() => setPanel({ kind: 'sheet' })}
            onOpenArtifact={openArtifact} onOpenPrintout={openPrintout} openArtifactId={panel?.kind === 'artifact' ? panel.id : contextArtifact} registerArtifactForm={registerArtifact} />
        </main>
        <Panel open={panel?.kind === 'shortcuts'} title="Keyboard shortcuts" onClose={close}>
          <Shortcuts forms={allForms} />
        </Panel>
        <Panel open={panel?.kind === 'sheet'} title="Count sheet" onClose={close} fill wide>
          <CountSheet onSend={() => { close(); openForm.current('submit_stock_count'); }} />
        </Panel>
        <Panel open={panel?.kind === 'artifact'} title={panel?.kind === 'artifact' ? panel.title : ''} onClose={close} fill>
          {panel?.kind === 'artifact' && <ArtifactPanel key={`${panel.id}:${panel.rev}`} id={panel.id} nonce={nonce} role={user.role} onOpenForm={formFromArtifact} onShare={shareForm} onClosed={close} onLoaded={retitle} />}
        </Panel>
        <Panel open={panel?.kind === 'printout'} title={panel?.kind === 'printout' ? panel.title : ''} onClose={close} fill wide>
          {panel?.kind === 'printout' && <PrintoutPanel key={`${panel.template}${JSON.stringify(panel.ref)}`} template={panel.template} refs={panel.ref} onLoaded={retitle} />}
        </Panel>
      </div>
    </div>
  );
}
