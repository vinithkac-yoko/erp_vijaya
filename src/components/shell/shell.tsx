'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { shortcutTool, type FormButton } from '@/lib/launcher/launcher';
import { ChatView, type ChatViewProps } from '@/components/chat/chat-view';
import { TopBar, type ChatLink, type ShellUser } from './top-bar';
import { Panel } from './panel';
import { Shortcuts } from './shortcuts';

type PanelView = 'shortcuts' | null;

function typingInField(t: EventTarget | null) {
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

export interface ShellProps {
  user: ShellUser;
  chats: ChatLink[];
  currentChatId: string | null;
  allForms: FormButton[];
  chat: Omit<ChatViewProps, 'inputRef' | 'registerOpenForm'>;
  /** Changes when another chat is opened (or a new one begun), so the chat view starts from what the server drew. */
  viewKey: string;
}

export function Shell({ user, chats, currentChatId, allForms, chat, viewKey }: ShellProps) {
  const [panel, setPanel] = useState<PanelView>(null);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const openForm = useRef<(tool: string) => void>(() => {});
  const close = useCallback(() => setPanel(null), []);
  const register = useCallback((fn: (tool: string) => void) => { openForm.current = fn; }, []);

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
      else if (e.key === '?') { e.preventDefault(); setPanel('shortcuts'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, close, user.role, chat.formEnabled]);

  return (
    <div className="flex h-dvh flex-col">
      <TopBar user={user} chats={chats} currentChatId={currentChatId} onHelp={() => setPanel('shortcuts')} />
      <div className="relative flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col xl:min-w-[420px]">
          <ChatView key={viewKey} {...chat} inputRef={chatInput} registerOpenForm={register} />
        </main>
        <Panel open={panel === 'shortcuts'} title="Keyboard shortcuts" onClose={close}>
          <Shortcuts forms={allForms} />
        </Panel>
      </div>
    </div>
  );
}
