'use client';

import { useTransition } from 'react';
import { Bookmark, Check, ChevronDown, CircleHelp, History, LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { logoutAction, setThemeAction } from '@/server/auth/actions';
import { CoilLine, BrandMark } from '@/components/brand';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/cn';

export interface ShellUser { name: string; role: 'OWNER' | 'STOREKEEPER'; theme: string | null }
export const roleLabel = (r: ShellUser['role']) => (r === 'OWNER' ? 'Owner' : 'Storekeeper');

const barButton =
  'inline-flex min-h-11 md:min-h-9 items-center gap-1.5 rounded-md px-2.5 sm:px-3 text-base font-medium text-plate-ink ' +
  'hover:bg-white/10 data-[state=open]:bg-white/10 [&:focus-visible]:outline-copper-light';

function applyTheme(value: 'light' | 'dark' | 'system') {
  const root = document.documentElement;
  if (value === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', value);
}

export function TopBar({ user, onHelp }: { user: ShellUser; onHelp: () => void }) {
  const [, startTransition] = useTransition();
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

        {/* Saved and Chats are filled in by later milestones; they are real menus now so the bar never changes shape. */}
        <DropdownMenu>
          <DropdownMenuTrigger className={barButton}>
            <Bookmark aria-hidden className="size-5 sm:size-4" /><span className="sr-only sm:not-sr-only">Saved</span><ChevronDown aria-hidden className="hidden size-4 sm:block" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Nothing saved yet.</DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger className={barButton}>
            <History aria-hidden className="size-5 sm:size-4" /><span className="sr-only sm:not-sr-only">Chats</span><ChevronDown aria-hidden className="hidden size-4 sm:block" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>No earlier chats yet.</DropdownMenuLabel>
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
