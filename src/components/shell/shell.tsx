'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormButton, Launcher } from '@/lib/launcher/launcher';
import { TopBar, type ShellUser } from './top-bar';
import { Chat } from './chat';
import { Panel } from './panel';
import { Shortcuts } from './shortcuts';

type PanelView = 'shortcuts' | null;

function typingInField(t: EventTarget | null) {
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

export function Shell({ user, launcher, allForms }: { user: ShellUser; launcher: Launcher; allForms: FormButton[] }) {
  const [panel, setPanel] = useState<PanelView>(null);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const close = useCallback(() => setPanel(null), []);

  // Lets tests (and nobody else) know the page has finished loading and keys will be heard.
  useEffect(() => { document.body.dataset.ready = 'true'; }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (panel) { e.preventDefault(); close(); } return; }
      if (typingInField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); chatInput.current?.focus(); }
      else if (e.key === '?') { e.preventDefault(); setPanel('shortcuts'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, close]);

  return (
    <div className="flex h-dvh flex-col">
      <TopBar user={user} onHelp={() => setPanel('shortcuts')} />
      <div className="relative flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col xl:min-w-[420px]"><Chat ref={chatInput} name={user.name} launcher={launcher} /></main>
        <Panel open={panel === 'shortcuts'} title="Keyboard shortcuts" onClose={close}>
          <Shortcuts forms={allForms} />
        </Panel>
      </div>
    </div>
  );
}
