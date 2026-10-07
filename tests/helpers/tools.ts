import { SETTINGS } from '@/lib/settings';
import { pendingActions, runTool } from '@/server/tools';
import type { ToolOutcome, ToolSession } from '@/server/tools/types';
import { prisma } from './db';
import { session } from './gateway';

export { session };
export const owner = () => session('OWNER');
export const storekeeper = () => session('STOREKEEPER');

/** What the seed does: the settings the system needs from day one. */
export async function seedSettings() {
  for (const d of SETTINGS) await prisma.setting.upsert({ where: { key: d.key }, create: { key: d.key, value: d.initial, valueType: d.type }, update: {} });
}

/** The user's whole write path, the way the app does it: open the form, then press its button. */
export async function save(s: ToolSession, tool: string, input: Record<string, unknown>, origin: 'LAUNCHER' | 'AGENT' | 'ARTIFACT' = 'LAUNCHER'): Promise<ToolOutcome> {
  const form = await pendingActions.create(s, { tool, origin });
  if (!form.ok) return form;
  return runTool(s, tool, input, { confirmation: form.data.id });
}

export async function ok<T = Record<string, unknown>>(p: Promise<ToolOutcome>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`expected success but got ${r.code}: ${r.message}`);
  return r.data as T;
}

export async function fails(p: Promise<ToolOutcome>) {
  const r = await p;
  if (r.ok) throw new Error('expected a refusal but it was accepted');
  return r;
}

export const material = (name: string, over: Record<string, unknown> = {}) => ({ name, uom: 'NOS', stockType: 'PER_JOB', ...over });
