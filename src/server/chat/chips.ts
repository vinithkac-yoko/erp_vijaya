import type { Chip } from '@/lib/cards';
import type { Role } from '@/lib/catalog';
import { launcherFor } from '@/lib/launcher/launcher';

/** What a chip needs to exist before it can work. A chip whose tools are not built yet stays switched off. */
export const CHIP_REQUIRES: Record<string, string[]> = {
  'Low stock': ['list_reorder_alerts'],
  'Waiting for me': ['list_pending_approvals'],
  'Open jobs': ['list_jobs'],
  'Stock today': ['get_material_balance'],
  'Stock value': ['get_stock_value', 'make_artifact'],
};

export const chipAvailable = (label: string, has: (tool: string) => boolean) => (CHIP_REQUIRES[label] ?? []).every(has);

/** What is natural to ask next, after these tools were used. Questions only: never a form, never anything that writes. */
const NEXT: Record<string, string[]> = {
  search_materials: ['Low stock', 'Stock today'],
  get_material_balance: ['Low stock', 'Open jobs'],
  list_reorder_alerts: ['Stock today', 'Open jobs'],
  list_pending_approvals: ['Low stock', 'Stock today'],
  search_parties: ['Stock today', 'Low stock'],
  list_jobs: ['Low stock', 'Stock today'],
  get_job: ['Open jobs', 'Low stock'],
  check_job_shortage: ['Low stock', 'Open jobs'],
};

/**
 * 2–3 chips after an answer, so there is never a blank prompt (INTERFACE §5). Chosen by rules from what was just used and
 * what this role has, not by the model, so they are instant and can never offer something the role may not do.
 */
export function contextualChips(role: Role, used: string[], lastAsk: string, has: (tool: string) => boolean): Chip[] {
  const l = launcherFor(role);
  const all = [...l.chips, ...l.moreChips].filter((c) => chipAvailable(c.label, has) && c.prompt !== lastAsk);
  const byLabel = new Map(all.map((c) => [c.label, c]));
  const picked: string[] = [];
  for (const t of [...used].reverse()) for (const label of NEXT[t] ?? []) if (byLabel.has(label) && !picked.includes(label)) picked.push(label);
  for (const c of all) if (!picked.includes(c.label)) picked.push(c.label);
  return picked.slice(0, 3).map((label) => ({ label, ask: (byLabel.get(label) as { prompt: string }).prompt }));
}
