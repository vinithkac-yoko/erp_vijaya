import type { FormDef } from './forms';

/** Everything the chat can show that is not plain text. Built on the SERVER; the model never writes a card. */
export interface TableColumn { key: string; label: string; align?: 'right' }
export type Card =
  | { kind: 'opening'; title: string; lines: { text: string; ask?: string; button?: string }[] }
  | { kind: 'form'; pendingId: string; tool: string; form: FormDef; values: Record<string, unknown>; assisted: boolean }
  | { kind: 'saved'; stamp: string; lines: string[]; auditId?: string }
  | { kind: 'table'; title?: string; columns: TableColumn[]; rows: Record<string, string>[]; note?: string }
  | { kind: 'notice'; tone: 'info' | 'warn'; text: string };

/** A single-tap suggestion after an answer: ask something, or open a form (never with a rate). Never destructive. */
export type Chip =
  | { label: string; ask: string }
  | { label: string; form: string; prefill?: Record<string, unknown> };

/** One line of the chat as the browser receives it. */
export type ChatItem =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string }
  | { id: string; role: 'card'; card: Card; /** forms only: what became of it */ state?: 'open' | 'saved' | 'closed' };
