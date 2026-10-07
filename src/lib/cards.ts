import type { FormDef } from './forms';

/** Everything the chat can show that is not plain text. Built on the SERVER; the model never writes a card. */
export interface TableColumn { key: string; label: string; align?: 'right' }
export type Card =
  | { kind: 'opening'; title: string; lines: { text: string; ask?: string; button?: string; sheet?: boolean; form?: string; prefill?: Record<string, unknown> }[] }
  | { kind: 'form'; pendingId: string; tool: string; form: FormDef; values: Record<string, unknown>; assisted: boolean; /** Read-only facts the server worked out when the form opened ("9 materials, ₹1,49,672"). */ info?: string[] }
  | { kind: 'saved'; stamp: string; lines: string[]; auditId?: string }
  | { kind: 'table'; title?: string; columns: TableColumn[]; rows: Record<string, string>[]; note?: string }
  | { kind: 'notice'; tone: 'info' | 'warn'; text: string }
  /** An artifact the assistant made or opened: "Below minimum · v1 — Open". It opens beside the chat when the person asked for it. */
  | { kind: 'artifact'; artifactId: string; title: string; version: number; artifactKind: 'document' | 'page'; open: boolean }
  /** A printout (one of the five fixed templates), opened beside the chat with Print and Download PDF. */
  | { kind: 'printout'; template: string; title: string; ref: Record<string, string>; open: boolean }
  /** A file the server will make when the person taps it, with their own role. */
  | { kind: 'download'; label: string; href: string };

/** A single-tap suggestion after an answer: ask something, or open a form (never with a rate). Never destructive. */
export type Chip =
  | { label: string; ask: string }
  | { label: string; form: string; prefill?: Record<string, unknown> }
  /** Opens the count sheet in the panel. */
  | { label: string; sheet: true };

/** One line of the chat as the browser receives it. */
export type ChatItem =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string }
  | { id: string; role: 'card'; card: Card; /** forms only: what became of it */ state?: 'open' | 'saved' | 'closed' };
