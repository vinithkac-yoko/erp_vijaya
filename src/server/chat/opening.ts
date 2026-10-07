import type { Card } from '@/lib/cards';
import { launcherFor } from '@/lib/launcher/launcher';
import { runTool } from '../tools';
import type { ToolSession } from '../tools/types';

export interface Opening { card: Card; badges: { pendingApprovals: number; belowMinimum: number } }

const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const ASK = Object.fromEntries([...launcherFor('OWNER').chips, ...launcherFor('OWNER').moreChips].map((c) => [c.label, c.prompt]));

/**
 * The first card in a new chat. Drawn from read tools, not model text, so it is instant and cannot be wrong
 * (INTERFACE §4). Jobs and expected deliveries join it when those parts are built.
 */
export async function openingFor(session: ToolSession): Promise<Opening> {
  const [alerts, waiting] = await Promise.all([
    runTool(session, 'list_reorder_alerts', {}),
    session.role === 'OWNER' ? runTool(session, 'list_pending_approvals', {}) : Promise.resolve(null),
  ]);
  const below = alerts.ok ? (alerts.data as { rows: unknown[] }).rows.length : 0;
  const waits = waiting?.ok ? (waiting.data as { purchaseOrders: unknown[]; counts: unknown[] }) : null;
  const pendingApprovals = waits ? waits.purchaseOrders.length + waits.counts.length : 0;

  const lines: { text: string; ask?: string; button?: string }[] = [];
  if (session.role === 'OWNER') {
    lines.push(pendingApprovals > 0 ? { text: `${pendingApprovals} waiting for you`, ask: ASK['Waiting for me'], button: 'Review approvals' } : { text: 'Nothing is waiting for you.' });
  }
  lines.push(below > 0 ? { text: `${below} below minimum`, ask: ASK['Low stock'], button: 'Low stock' } : { text: 'Nothing is below its minimum.' });
  return { card: { kind: 'opening', title: `Welcome, ${first(session.name)}.`, lines }, badges: { pendingApprovals, belowMinimum: below } };
}
