import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db';
import { addMaterials } from './stock-load';
import { readOpeningStock } from './stock-data';

/**
 * Materials the store has asked to be added (a list kept with the code in prisma/data/materials/*.json: description, unit, kind,
 * part number as the item code; no quantities) are added ONCE each at start-up, through the Tool Gateway as the owner, one
 * create_material and one audit row per material. A marker row in `settings` per file (never listed among the owner's settings)
 * is written when a file has been added in full, so a restart or a redeploy never adds it twice, and a material the owner
 * renamed or put out of use afterwards is never added back. A material already in the list is left alone, and a list that stops
 * half way carries on at the next start without making anything twice.
 *
 * It does nothing, and says why in the log, when MATERIAL_LISTS_LOAD is off, on a demo copy, or with no owner login yet.
 */
export const LIST_MARKER_PREFIX = 'system.material_list:';
export const LISTS_DIR = 'prisma/data/materials';

export interface ListResult { file: string; status: 'added' | 'partial' | 'skipped'; made: number; reason?: string }

export async function loadMaterialListsOnce(opts: { env?: Record<string, string | undefined>; dir?: string; now?: Date; say?: (line: string) => void } = {}): Promise<ListResult[]> {
  const env = opts.env ?? process.env;
  const say = opts.say ?? (() => {});
  if (env.MATERIAL_LISTS_LOAD === 'off') { say('Material lists: not added — MATERIAL_LISTS_LOAD is off.'); return []; }
  if (env.DEMO_MODE === 'true') { say('Material lists: not added — this is a demo copy.'); return []; }
  const dir = opts.dir ?? join(process.cwd(), LISTS_DIR);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const results: ListResult[] = [];
  for (const file of files) {
    const key = `${LIST_MARKER_PREFIX}${file}`;
    if (await db.setting.findUnique({ where: { key } })) { results.push({ file, status: 'skipped', made: 0, reason: 'added already' }); continue; }
    const owner = await db.user.findFirst({ where: { role: 'OWNER', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } });
    if (!owner) { say(`Material list ${file}: not added — there is no owner login yet.`); results.push({ file, status: 'skipped', made: 0, reason: 'no owner' }); continue; }
    const { file: list, materials } = readOpeningStock(join(dir, file));
    say(`Material list ${file}: adding ${materials.length} materials from ${list.source} (made ${list.madeOn}) …`);
    const r = await addMaterials(materials, { userId: owner.id, name: owner.name, role: 'OWNER' }, say);
    if (r.refused.length > 0) { results.push({ file, status: 'partial', made: r.made, reason: r.refused[0] }); continue; }
    const now = (opts.now ?? new Date()).toISOString();
    await db.setting.upsert({ where: { key }, create: { key, value: now, valueType: 'string', description: 'Set when this list of materials has been added. Never shown in the settings list.' }, update: { value: now } });
    say(`Material list ${file}: done. ${r.made} materials added${r.skippedExisting ? `, ${r.skippedExisting} were already there` : ''}.`);
    results.push({ file, status: 'added', made: r.made });
  }
  return results;
}
