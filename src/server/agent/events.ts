import type { ChatItem, Chip } from '@/lib/cards';

/** What the chat stream sends to the browser, one JSON object per line. */
export type ChatEvent =
  | { type: 'conversation'; id: string }
  | { type: 'status'; text: string }
  | { type: 'text'; id: string; delta: string }
  | { type: 'item'; item: ChatItem }
  | { type: 'chips'; chips: Chip[] }
  | { type: 'done' };
