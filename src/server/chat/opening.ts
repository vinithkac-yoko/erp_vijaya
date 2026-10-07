import type { Card } from '@/lib/cards';
import { inr } from '@/lib/format';
import { launcherFor } from '@/lib/launcher/launcher';
import { notifications, runTool } from '../tools';
import type { ToolSession } from '../tools/types';

export interface Opening { card: Card; badges: { pendingApprovals: number; belowMinimum: number }; /** Notices drawn on the card: mark them read once the card is shown. */ noticeIds: string[] }

const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const ASK = Object.fromEntries([...launcherFor('OWNER').chips, ...launcherFor('OWNER').moreChips].map((c) => [c.label, c.prompt]));

/**
 * The first card in a new chat. Drawn from read tools, not model text, so it is instant and cannot be wrong
 * (INTERFACE §4). Jobs and expected deliveries join it when those parts are built.
 */
export async function openingFor(session: ToolSession): Promise<Opening> {
  const [alerts, waiting, counts, notices] = await Promise.all([
    runTool(session, 'list_reorder_alerts', {}),
    session.role === 'OWNER' ? runTool(session, 'list_pending_approvals', {}) : Promise.resolve(null),
    runTool(session, 'list_counts', {}),
    notifications.unread(session.userId, ['RECOUNT_REQUIRED', 'COUNT_APPROVED', 'PO_APPROVED', 'PO_REJECTED', 'RATE_CHANGE']),
  ]);
  const below = alerts.ok ? (alerts.data as { rows: unknown[] }).rows.length : 0;
  const waits = waiting?.ok ? (waiting.data as { purchaseOrders: { id: string; number: string; supplier: string; total: number; job: string | null }[]; counts: { id: string; number: string; kind: string; summary: string }[] }) : null;
  const pendingApprovals = waits ? waits.purchaseOrders.length + waits.counts.length : 0;

  const lines: { text: string; ask?: string; button?: string; sheet?: boolean; form?: string; prefill?: Record<string, unknown> }[] = [];
  if (session.role === 'OWNER') {
    lines.push(pendingApprovals > 0 ? { text: `${pendingApprovals} waiting for you`, ask: ASK['Waiting for me'], button: 'Review approvals' } : { text: 'Nothing is waiting for you.' });
    for (const p of waits?.purchaseOrders ?? []) lines.push({ text: `${p.number}: ${p.supplier}, ${inr(p.total)}${p.job ? `, for ${p.job}` : ''}`, form: 'approve_purchase_order', prefill: { purchaseOrderId: p.id }, button: 'Review it' });
    for (const c of waits?.counts ?? []) lines.push({ text: `${c.kind} ${c.number}: ${c.summary}`, form: 'approve_stock_count', button: 'Review it' });
  }
  for (const n of notices) lines.push({ text: `${n.title}: ${n.body}` });
  // A count that is still with the storekeeper (in progress, or sent back): the way back to the sheet is one tap.
  const mine = counts.ok ? (counts.data as { rows: { number: string; type: string; status: string; counted: number; total: number }[] }).rows.find((r) => r.status === 'DRAFT' || r.status === 'REJECTED') : undefined;
  if (mine) lines.push({ text: `${mine.type} ${mine.number} is ${mine.status === 'REJECTED' ? 'sent back' : 'in progress'}: ${mine.counted} of ${mine.total} counted`, sheet: true, button: 'Open the count sheet' });
  lines.push(below > 0 ? { text: `${below} below minimum`, ask: ASK['Low stock'], button: 'Low stock' } : { text: 'Nothing is below its minimum.' });
  return { card: { kind: 'opening', title: `Welcome, ${first(session.name)}.`, lines }, badges: { pendingApprovals, belowMinimum: below }, noticeIds: notices.map((n) => n.id) };
}
