import { itemCodeKey, materialNameKey } from '@/lib/names';
import type { Existing, PlannedMaterial, Unit } from './stock-import';

/**
 * A plain list of materials (a description and, usually, a part number), such as the store's tape list: no quantities, no
 * rates. This only DECIDES what each row becomes, like stock-import.ts; saving goes through the Tool Gateway (stock-load.ts).
 *
 * The sheet writes the part number in brackets at the end of the description, and again in its own column. The name is the
 * description without the bracket (the part number is the material's item code, shown and searchable beside it). A part
 * number written against two different descriptions is given to neither (nobody can tell which owns it); the same description
 * twice is one material.
 */
export interface ListRow { line: number; description: string; code: string }
export interface ListOptions { category: string; uom: Unit; stockType: 'STANDING' | 'PER_JOB'; minimumLevel?: number }
export interface ListPlan { materials: PlannedMaterial[]; skipped: { line: number; reason: string; description: string; code: string }[]; alreadyThere: string[]; counts: { rows: number; materials: number; withCode: number; withoutCode: number; merged: number; codeShared: number } }

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Header and total lines of an accounts printout are not materials. */
const NOT_AN_ITEM = /^(particulars|description|tape discription|tape description|grand total|total|opening balance|closing balance)$/i;
const TRAILING_BRACKET = /\(([^()]*)\)\s*$/;
const looksLikeCode = (s: string) => /^[A-Za-z0-9][A-Za-z0-9 \-./]{2,24}$/.test(s) && /\d/.test(s);

export function planMaterialList(input: ListRow[], opts: ListOptions, existing: Existing = { nameKeys: new Set(), itemCodeKeys: new Set(), replaceCount: 0 }): ListPlan {
  const skipped: ListPlan['skipped'] = [];
  interface Item { line: number; name: string; code: string; flags: string[] }
  const items: Item[] = [];
  let rows = 0;
  for (const r of input) {
    const description = clean(r.description);
    const columnCode = clean(r.code).replace(/^\(|\)$/g, '').trim();
    if (!description && !columnCode) continue;
    rows++;
    if (!description) { skipped.push({ line: r.line, reason: 'A part number with no description (the same number is with the next description)', description, code: columnCode }); continue; }
    if (NOT_AN_ITEM.test(description)) { skipped.push({ line: r.line, reason: 'A heading or total line, not an item', description, code: columnCode }); continue; }
    let name = description;
    let code = columnCode;
    const m = TRAILING_BRACKET.exec(description);
    if (m && looksLikeCode(clean(m[1]))) {
      name = clean(description.slice(0, m.index));
      if (!code) code = clean(m[1]);
    }
    items.push({ line: r.line, name: name.slice(0, 120), code: code.slice(0, 40), flags: [] });
  }

  // the same description (any spacing or case) is one material
  const byName = new Map<string, Item[]>();
  for (const it of items) {
    const key = materialNameKey(it.name);
    if (!key) { skipped.push({ line: it.line, reason: 'No usable name', description: it.name, code: it.code }); continue; }
    (byName.get(key) ?? byName.set(key, []).get(key)!).push(it);
  }

  const alreadyThere: string[] = [];
  interface Draft { m: PlannedMaterial; codes: string[]; notes: string[] }
  const drafts: Draft[] = [];
  let merged = 0;
  for (const [key, group] of byName) {
    if (existing.nameKeys.has(key)) { alreadyThere.push(group[0]!.name); continue; }
    merged += group.length - 1;
    const codes = [...new Set(group.map((g) => g.code).filter(Boolean))];
    drafts.push({
      codes, notes: [],
      m: {
        name: group[0]!.name, itemCode: codes.length === 1 ? codes[0]! : null, category: opts.category, uom: opts.uom, stockType: opts.stockType,
        ...(opts.stockType === 'STANDING' && opts.minimumLevel !== undefined ? { minimumLevel: opts.minimumLevel } : {}),
        rack: null, shelf: null, notes: null, counted: null, lines: group.map((g) => g.line), flags: codes.length === 0 ? ['no part number on the sheet'] : [],
      },
    });
  }

  // a part number is the material's item code and is unique: one written against different descriptions goes to none of them
  const owners = new Map<string, number>();
  for (const d of drafts) for (const c of d.codes) owners.set(itemCodeKey(c), (owners.get(itemCodeKey(c)) ?? 0) + 1);
  let codeShared = 0;
  const materials = drafts.map(({ m, codes, notes }) => {
    const shared = codes.length > 1 || codes.some((c) => (owners.get(itemCodeKey(c)) ?? 0) > 1 || existing.itemCodeKeys.has(itemCodeKey(c)));
    if (shared) {
      codeShared++;
      m.itemCode = null;
      notes.push(`Part number on the sheet: ${codes.join(', ')} (also on another description, so not used as the item code)`);
      m.flags.push('the sheet\'s part number is shared with another description: not used as the item code');
    }
    m.notes = notes.join('. ').slice(0, 500) || null;
    return m;
  });

  return {
    materials, skipped, alreadyThere,
    counts: { rows, materials: materials.length, withCode: materials.filter((m) => m.itemCode).length, withoutCode: materials.filter((m) => !m.itemCode).length, merged, codeShared },
  };
}
