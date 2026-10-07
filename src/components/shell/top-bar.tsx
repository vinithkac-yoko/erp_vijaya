'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { Bookmark, Check, FileText, LayoutDashboard, ChevronDown, CircleHelp, History, LogOut, Monitor, Moon, Plus, Settings, Sun } from 'lucide-react';
import { logoutAction, setThemeAction } from '@/server/auth/actions';
import { CoilLine, BrandMark } from '@/components/brand';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/cn';
import { listArtifactsAction } from '@/server/artifacts/actions';
import type { ArtifactRow } from '@/server/artifacts/store';

export interface ShellUser { name: string; role: 'OWNER' | 'STOREKEEPER'; theme: string | null }
export interface ChatLink { id: string; title: string }
export const roleLabel = (r: ShellUser['role']) => (r === 'OWNER' ? 'Owner' : 'Storekeeper');

const barButton =
  'inline-flex min-h-11 md:min-h-9 items-center gap-1.5 rounded-md px-2.5 sm:px-3 text-base font-medium text-plate-ink ' +
  'hover:bg-white/10 data-[state=open]:bg-white/10 [&:focus-visible]:outline-copper-light';

function applyTheme(value: 'light' | 'dark' | 'system') {
  const root = document.documentElement;
  if (value === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', value);
}

export function TopBar({ user, chats, currentChatId, onHelp, onSettings, onOpenArtifact }: { user: ShellUser; chats: ChatLink[]; currentChatId: string | null; onHelp: () => void; onOpenArtifact: (id: string, title: string) => void; /** Owner only: opens the form for changing a setting. It needs no assistant, so it also works when the assistant is off. */ onSettings?: () => void }) {
  const [, startTransition] = useTransition();
  const [saved, setSaved] = useState<{ mine: ArtifactRow[]; shared: ArtifactRow[] } | null>(null);
  const loadSaved = (open: boolean) => { if (open) void listArtifactsAction().then((r) => { if (r.ok) setSaved({ mine: r.mine, shared: r.shared }); }); };
  const current = user.theme === 'light' || user.theme === 'dark' ? user.theme : 'system';
  const choose = (v: 'light' | 'dark' | 'system') => { applyTheme(v); startTransition(() => { void setThemeAction(v); }); };
  const themeItems = [
    { v: 'light', label: 'Light', Icon: Sun },
    { v: 'dark', label: 'Dark', Icon: Moon },
    { v: 'system', label: 'Same as this device', Icon: Monitor },
  ] as const;

  return (
    <header className="relative shrink-0 overflow-hidden border-b-[3px] border-copper bg-plate text-plate-ink">
      <CoilLine />
      <div className="relative flex items-center gap-1 px-3 py-2 sm:gap-2 sm:px-5">
        <BrandMark className="mr-2 sm:mr-6" />

        <DropdownMenu onOpenChange={loadSaved}>
          <DropdownMenuTrigger className={barButton}>
            <Bookmark aria-hidden className="size-5 sm:size-4" /><span className="sr-only sm:not-sr-only">Saved</span><ChevronDown aria-hidden className="hidden size-4 sm:block" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-80">
            {!saved && <DropdownMenuLabel>Looking…</DropdownMenuLabel>}
            {saved && saved.mine.length === 0 && saved.shared.length === 0 && <DropdownMenuLabel>Nothing yet. Ask for a report, chart or document and it appears here.</DropdownMenuLabel>}
            {saved && saved.mine.filter((a) => a.saved).length > 0 && <DropdownMenuLabel>Saved</DropdownMenuLabel>}
            {saved?.mine.filter((a) => a.saved).map((a) => <ArtifactItem key={a.artifactId} a={a} onOpen={onOpenArtifact} />)}
            {saved && saved.mine.filter((a) => !a.saved).length > 0 && <DropdownMenuLabel>Recent</DropdownMenuLabel>}
            {saved?.mine.filter((a) => !a.saved).slice(0, 8).map((a) => <ArtifactItem key={a.artifactId} a={a} onOpen={onOpenArtifact} />)}
            {saved && saved.shared.length > 0 && <DropdownMenuLabel>Shared with me</DropdownMenuLabel>}
            {saved?.shared.map((a) => <ArtifactItem key={a.artifactId} a={a} onOpen={onOpenArtifact} />)}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger className={barButton}>
            <History aria-hidden className="size-5 sm:size-4" /><span className="sr-only sm:not-sr-only">Chats</span><ChevronDown aria-hidden className="hidden size-4 sm:block" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuItem asChild>
              <Link href="/" className="font-medium"><Plus aria-hidden className="size-4" />New chat</Link>
            </DropdownMenuItem>
            {chats.length === 0 ? <DropdownMenuLabel>No earlier chats yet.</DropdownMenuLabel> : <DropdownMenuSeparator />}
            {chats.map((c) => (
              <DropdownMenuItem key={c.id} asChild>
                <Link href={`/?c=${c.id}`} aria-current={c.id === currentChatId ? 'page' : undefined} className={c.id === currentChatId ? 'bg-copper-wash' : undefined}>
                  <span className="truncate">{c.title}</span>
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={onHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"
            className={cn(barButton, 'hidden px-0 md:inline-flex md:w-9 md:justify-center')}>
            <CircleHelp aria-hidden className="size-5" />
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger className={barButton} aria-label={`${user.name}, ${roleLabel(user.role)}. Open menu`}>
              <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-copper-light font-semibold text-plate sm:hidden">
                {user.name.trim().charAt(0).toUpperCase()}
              </span>
              <span className="hidden max-w-48 truncate sm:inline">{user.name}</span>
              <ChevronDown aria-hidden className="hidden size-4 sm:block" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                <span className="block font-semibold text-ink">{user.name}</span>
                <span className="block">{roleLabel(user.role)}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Look</DropdownMenuLabel>
              {themeItems.map(({ v, label, Icon }) => (
                <DropdownMenuItem key={v} onSelect={() => choose(v)}>
                  <Icon aria-hidden className="size-4" /><span className="flex-1">{label}</span>
                  {current === v && <Check aria-label="Chosen" className="size-4 text-confirm" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {onSettings && (
                <DropdownMenuItem onSelect={onSettings}>
                  <Settings aria-hidden className="size-4" />Settings
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={onHelp} className="md:hidden">
                <CircleHelp aria-hidden className="size-4" />Keyboard shortcuts
              </DropdownMenuItem>
              {/* Called directly: a <form> inside the menu is removed when the menu closes, before it can submit. */}
              <DropdownMenuItem onSelect={() => startTransition(() => { void logoutAction(); })}>
                <LogOut aria-hidden className="size-4" />Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

function ArtifactItem({ a, onOpen }: { a: ArtifactRow; onOpen: (id: string, title: string) => void }) {
  const Icon = a.kind === 'page' ? LayoutDashboard : FileText;
  return (
    <DropdownMenuItem onSelect={() => onOpen(a.artifactId, a.title)}>
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1"><span className="block truncate">{a.title}</span>{a.sharedBy && <span className="block text-sm text-ink-soft">Shared by {a.sharedBy} · version {a.version}</span>}</span>
    </DropdownMenuItem>
  );
}
