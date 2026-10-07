import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dateText } from '@/lib/format';
import { financialYear } from '@/lib/fy';
import type { Role } from '@/lib/catalog';

let cached: string | undefined;

/**
 * The agent's system prompt: the text between the markers in docs/AGENT_PROMPT.md, unchanged. The same bytes every
 * request, so it can be cached. Edit the document, not the code, and run the agent evals afterwards.
 */
export function systemPrompt(): string {
  if (cached) return cached;
  const doc = readFileSync(join(process.cwd(), 'docs', 'AGENT_PROMPT.md'), 'utf8');
  const start = doc.indexOf('<!-- PROMPT START -->'), end = doc.indexOf('<!-- PROMPT END -->');
  if (start < 0 || end < start) throw new Error('docs/AGENT_PROMPT.md has lost its PROMPT START / PROMPT END markers.');
  cached = doc.slice(start + '<!-- PROMPT START -->'.length, end).trim();
  return cached;
}

export interface ContextInput {
  name: string;
  role: Role;
  now: Date;
  /** Owner only: what is waiting for him. */
  waiting?: { purchaseOrders: number; counts: number };
}

/** "2026-27", from the same function that numbers the documents. */
export const financialYearLabel = (d: Date) => { const fy = financialYear(d); return `20${fy.slice(0, 2)}-${fy.slice(2)}`; };

/** Appended per request, after the cached part. */
export function sessionContext(i: ContextInput): string {
  const lines = [
    '═══ THIS CONVERSATION ═══',
    `You are talking to ${i.name}, the ${i.role}.`,
    `Today is ${dateText(i.now)}. Financial year ${financialYearLabel(i.now)}.`,
  ];
  if (i.role === 'OWNER' && i.waiting) lines.push(`Waiting for you: ${i.waiting.purchaseOrders} purchase orders, ${i.waiting.counts} stock counts.`);
  return lines.join('\n');
}
