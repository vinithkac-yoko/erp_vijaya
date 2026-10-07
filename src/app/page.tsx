import { randomUUID } from 'node:crypto';
import { requireUser } from '@/server/auth/session';
import { launcherState } from '@/server/chat/launcher';
import { openingFor } from '@/server/chat/opening';
import { assistantRuntime } from '@/server/chat/runtime';
import { ASSISTANT_OFF } from '@/server/agent/config';
import { conversations, notifications } from '@/server/tools';
import type { ChatItem } from '@/lib/cards';
import { Shell } from '@/components/shell/shell';

export default async function Home({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const user = await requireUser();
  const session = { userId: user.id, name: user.name, role: user.role };
  const { c } = await searchParams;

  const { on } = await assistantRuntime();
  const [state, opening, chats] = await Promise.all([launcherState(session, on), openingFor(session), conversations.recent(user.id)]);

  // An existing chat (?c=…) shows its own history; a new chat starts with the opening card, drawn by the server.
  const existing = c ? await conversations.items(user.id, c) : null;
  const items: ChatItem[] = existing ?? [{ id: 'opening', role: 'card', card: opening.card }];
  if (!existing) await notifications.markRead(user.id, opening.noticeIds); // told once, on the card

  return (
    <Shell
      user={{ name: user.name, role: user.role, theme: user.theme }}
      chats={chats.map((x) => ({ id: x.id, title: x.title }))}
      currentChatId={existing ? (c ?? null) : null}
      allForms={state.allForms}
      viewKey={existing && c ? c : `new-${randomUUID()}`}
      chat={{
        initialItems: items, conversationId: existing ? (c ?? null) : null, launcher: state.launcher, formEnabled: state.formEnabled, chipEnabled: state.chipEnabled,
        badges: opening.badges, assistantOn: on, offMessage: ASSISTANT_OFF,
      }}
    />
  );
}
