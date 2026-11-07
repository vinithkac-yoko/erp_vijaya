import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db';
import { applyStockPlan } from './stock-load';
import { OPENING_STOCK_PATH, readOpeningStock } from './stock-data';

/**
 * Loads the store's opening stock (prisma/data/opening-stock.json) ONCE, at start-up, and never again.
 *
 * It goes through the Tool Gateway exactly as the stock:import command does (a create_material per material, then the opening
 * count and its quantities), as the owner, with an audit row each. It never submits the count: that needs a rate for every
 * material with stock. A marker row in `settings` (not one of the owner's settings, so nobody sees it in the list) is written
 * when the load has finished, so a restart, a redeploy or a renamed material can never make it run again.
 *
 * It does nothing, and says why in the log, when: it was done already; OPENING_STOCK_LOAD is off; this is a demo copy; the
 * file is not there; stock has already moved or the opening count is approved (an opening count has to come first); or there
 * is no owner login yet.
 */
export const MARKER_KEY = 'system.opening_stock_loaded';

export type StartupResult =
  | { status: 'loaded'; materials: number; quantities: number; needRate: number; refused: number }
  | { status: 'partial'; reason: string }
  | { status: 'skipped'; reason: string };

export async function loadOpeningStockOnce(opts: { env?: Record<string, string | undefined>; path?: string; now?: Date; say?: (line: string) => void } = {}): Promise<StartupResult> {
  const env = opts.env ?? process.env;
  const say = opts.say ?? (() => {});
  const skip = (reason: string): StartupResult => { say(`Opening stock: not loaded — ${reason}`); return { status: 'skipped', reason }; };

  if (env.OPENING_STOCK_LOAD === 'off') return skip('OPENING_STOCK_LOAD is off.');
  if (env.DEMO_MODE === 'true') return skip('this is a demo copy.');
  const path = opts.path ?? join(process.cwd(), OPENING_STOCK_PATH);
  if (!existsSync(path)) return skip('there is no stock file.');
  if (await db.setting.findUnique({ where: { key: MARKER_KEY } })) return skip('it was loaded already.');
  if ((await db.stockMovement.count()) > 0) return skip('stock has already moved, and the opening count has to come first.');
  if ((await db.stockCount.count({ where: { isOpening: true, status: 'APPROVED' } })) > 0) return skip('the opening count is already approved.');
  const owner = await db.user.findFirst({ where: { role: 'OWNER', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } });
  if (!owner) return skip('there is no owner login yet.');

  const { file, materials } = readOpeningStock(path);
  say(`Opening stock: loading ${materials.length} materials from ${file.source} (made ${file.madeOn}) …`);
  const now = opts.now ?? new Date();
  const date = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const existing = await db.material.findMany({ select: { nameKey: true } });
  const have = new Set(existing.map((m) => m.nameKey));
  const { materialNameKey } = await import('@/lib/names');
  const fresh = materials.filter((m) => !have.has(materialNameKey(m.name)));
  const known = materials.filter((m) => have.has(materialNameKey(m.name)));
  const r = await applyStockPlan({ materials: fresh, alreadyThere: known }, { userId: owner.id, name: owner.name, role: 'OWNER' }, date, say);

  // finished only if every material is in and the count is open; otherwise the next start carries on (it never makes a material twice)
  if (r.refused.length > 0 || r.countNumber === null || r.countApproved) return { status: 'partial', reason: r.refused[0] ?? 'the opening count could not be started' };
  await db.setting.upsert({ where: { key: MARKER_KEY }, create: { key: MARKER_KEY, value: now.toISOString(), valueType: 'string', description: 'Set when the opening stock file has been loaded. Never shown in the settings list.' }, update: { value: now.toISOString() } });
  say(`Opening stock: done. ${r.made} materials added, ${r.quantitiesSaved} quantities on ${r.countNumber}; ${r.needRate} materials with stock still need a rate.`);
  return { status: 'loaded', materials: r.made, quantities: r.quantitiesSaved, needRate: r.needRate, refused: 0 };
}
