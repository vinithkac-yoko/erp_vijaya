import { itemCodeKey, materialNameKey } from '@/lib/names';

/**
 * Turning the store's own stock sheet (the STOCK sheet of the rack-wise workbook) into materials and opening-count quantities
 * (milestone 13). This file only DECIDES: it reads rows and says what each would become, and what it could not decide. It
 * saves nothing; the loader (prisma/import-stock.ts) saves through the Tool Gateway, one reviewed material at a time.
 *
 * The rules are the owner's: only MISC and CONS are kept in stock (the rest are bought for each job); a row with no description
 * is named replace1, replace2 …; the sheet's columns are Part No, Description, Qty, UOM, Rack, Shelf, Remarks, with the kind
 * (CORE, BOBBIN, WIRE …) in the unlabeled column before Part No.
 *
 * What the sheet cannot be trusted for is said, never hidden: a code written against several different descriptions is not
 * given to any of them; a unit can never be changed later, so a row whose unit is not on the sheet is held back, not guessed.
 */
export interface SheetRow { line: number; category: string; code: string; description: string; qty: string; uom: string; rack: string; shelf: string; remark: string }
export type Unit = 'KG' | 'NOS' | 'MTR' | 'LTR' | 'ROLL' | 'SET';

export interface PlannedMaterial {
  name: string; itemCode: string | null; category: string | null; uom: Unit; stockType: 'STANDING' | 'PER_JOB'; minimumLevel?: number;
  rack: string | null; shelf: string | null; notes: string | null;
  /** The quantity for the opening count. null = the sheet gave none, so it stays uncounted. */
  counted: number | null;
  lines: number[];
  /** Things a person should look at, in words. */
  flags: string[];
}
export interface HeldBack { line: number; reason: string; row: SheetRow }
export interface Plan {
  materials: PlannedMaterial[];
  /** Rows that did not become a material, with the reason in plain words. */
  heldBack: HeldBack[];
  /** Rows that are not items at all (no kind and no code: headings such as "Consumbles Items"). */
  skipped: HeldBack[];
  /** Materials already in the list: not made again, but their sheet quantities can still be put on the count sheet. */
  alreadyThere: PlannedMaterial[];
  counts: { rows: number; materials: number; standing: number; perJob: number; replaceNamed: number; merged: number; withCode: number; codeShared: number; uncounted: number; zero: number };
}

const KEPT_IN_STOCK = new Set(['MISC', 'CONS']);
/** The units the store counts in whole numbers only (the same rule as receiving and issuing). */
const WHOLE_UNITS = new Set<Unit>(['NOS', 'SET']);

const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** One word for a unit, as the sheet writes it ("KGS", "kgs", "Mtr", "(ltr)", "N0S") → ours. null = not a unit we know. */
export function unitOf(word: string): { unit: Unit; flag?: string } | null {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^n0s$/, 'nos');
  if (/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/.test(w)) return { unit: 'KG' };
  if (/^(nos|no|pcs|pc|piece|pieces|numbers)$/.test(w)) return { unit: 'NOS' };
  if (/^(mtr|mtrs|m|meter|meters|metre|metres)$/.test(w)) return { unit: 'MTR' };
  if (/^(ltr|ltrs|l|lt|litre|litres|liter|liters)$/.test(w) || /^\d+ltr$/.test(w)) return { unit: 'LTR' };
  if (/^(roll|rolls)$/.test(w)) return { unit: 'ROLL' };
  if (/^(set|sets)$/.test(w)) return { unit: 'SET' };
  if (/^(pair|pairs)$/.test(w)) return { unit: 'SET', flag: 'the sheet counts in pairs; kept as sets' };
  if (/^(grm|gm|gms|gram|grams)$/.test(w)) return { unit: 'KG', flag: 'the sheet says grams but the quantity looks like kilos: please check' };
  return null;
}

/** "108", "1,950", "20 KGS", "7.kgs", "5 (ltr)", "321(PAIR)", "NIL" → a number and, if written there, a unit. '' → no quantity. */
export function quantityOf(text: string): { qty: number | null; unit: ReturnType<typeof unitOf>; bad?: boolean } {
  const t = clean(text);
  if (t === '') return { qty: null, unit: null };
  if (/^(nil|nill|none|-+|zero)$/i.test(t)) return { qty: 0, unit: null };
  const m = /^([\d,]+(?:\.\d+)?)\s*\.?\s*\(?\s*([A-Za-z0-9 .]*?)\s*\)?\s*\.?$/.exec(t);
  if (!m) return { qty: null, unit: null, bad: true };
  const qty = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(qty)) return { qty: null, unit: null, bad: true };
  const word = m[2]!.trim();
  const unit = word ? unitOf(word) : null;
  return { qty, unit, ...(word !== '' && !unit ? { bad: true } : {}) };
}

const SHARE = 0.95;

/** The one unit a whole kind of thing is counted in ("every SLEEVE row is in metres"), or null if it is not that clear. */
function unitByKind(rows: { category: string; unit: Unit | null }[]): Map<string, Unit> {
  const seen = new Map<string, Map<Unit, number>>();
  for (const r of rows) {
    if (!r.category || !r.unit) continue;
    const m = seen.get(r.category) ?? new Map<Unit, number>();
    m.set(r.unit, (m.get(r.unit) ?? 0) + 1);
    seen.set(r.category, m);
  }
  const out = new Map<string, Unit>();
  for (const [cat, m] of seen) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const [top, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0]!;
    if (total >= 3 && n / total >= SHARE) out.set(cat, top);
  }
  return out;
}

export interface Existing { nameKeys: Set<string>; itemCodeKeys: Set<string>; replaceCount: number }

export function planStockImport(input: SheetRow[], existing: Existing = { nameKeys: new Set(), itemCodeKeys: new Set(), replaceCount: 0 }): Plan {
  const heldBack: HeldBack[] = [];
  const skipped: HeldBack[] = [];

  // 1. Read every row: what it says about its quantity and its unit.
  interface Parsed { row: SheetRow; category: string; code: string; description: string; qty: number | null; unit: Unit | null; unitFlag?: string; unitFrom?: 'qty' | 'column' }
  const parsed: Parsed[] = [];
  let itemRows = 0;
  for (const raw of input) {
    const row: SheetRow = { ...raw, category: clean(raw.category).toUpperCase(), code: String(raw.code ?? '').replace(/\s+/g, ' ').trim(), description: clean(raw.description), qty: clean(raw.qty), uom: clean(raw.uom), rack: clean(raw.rack), shelf: clean(raw.shelf), remark: clean(raw.remark) };
    if (!row.category && !row.code && !row.description && !row.qty && !row.uom) continue;
    itemRows++;
    if (!row.category && !row.code) { skipped.push({ line: row.line, reason: 'No kind and no part number: not an item', row }); continue; }
    const q = quantityOf(row.qty);
    if (q.bad) { heldBack.push({ line: row.line, reason: `The quantity "${row.qty}" is not a number`, row }); continue; }
    // the unit written with the quantity ("5 (ltr)") is more careful than the UOM column ("3 LTR"), so it wins
    const fromCol = row.uom ? unitOf(row.uom.replace(/^\d+\s*/, '')) : null;
    const u = q.unit ?? fromCol;
    parsed.push({ row, category: row.category, code: row.code, description: row.description, qty: q.qty, unit: u?.unit ?? null, unitFlag: u?.flag, unitFrom: q.unit ? 'qty' : fromCol ? 'column' : undefined });
  }
  const kindUnit = unitByKind(parsed.map((p) => ({ category: p.category, unit: p.unit })));

  // 2. Give every row a name and a unit.
  let replace = existing.replaceCount;
  interface Named extends Parsed { name: string; unitGuessed: boolean; replaceNamed: boolean }
  const named: Named[] = [];
  for (const p of parsed) {
    let unit = p.unit, unitGuessed = false;
    if (!unit && kindUnit.has(p.category)) { unit = kindUnit.get(p.category)!; unitGuessed = true; }
    if (!unit) { heldBack.push({ line: p.row.line, reason: 'The sheet does not say the unit (and a unit cannot be changed later)', row: p.row }); continue; }
    // a row whose code is already a material (a re-run) is that material
    if (!p.description && p.code && existing.itemCodeKeys.has(itemCodeKey(p.code))) continue;
    // a quantity with a fraction in a unit that is counted whole ("3.35 NOS") means the unit or the number is wrong; the unit cannot be changed later
    if (p.qty !== null && !Number.isInteger(p.qty) && WHOLE_UNITS.has(unit)) { heldBack.push({ line: p.row.line, reason: `The quantity ${p.qty} has a fraction but the unit is pieces (is it kilos?)`, row: p.row }); continue; }
    // rows with no description have no other identity: once any replace material exists they were loaded by an earlier run
    if (!p.description && existing.replaceCount > 0) continue;
    const replaceNamed = !p.description;
    const name = replaceNamed ? `replace${++replace}` : p.description.slice(0, 120);
    named.push({ ...p, unit, unitGuessed, name, replaceNamed });
  }

  // 3. The same description on several rows is one material (the database allows one of each): quantities add up.
  const groups = new Map<string, Named[]>();
  for (const n of named) {
    const key = materialNameKey(n.name);
    if (!key) { heldBack.push({ line: n.row.line, reason: 'No usable name', row: n.row }); continue; }
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(n);
  }
  const alreadyThere: PlannedMaterial[] = [];
  /** A material and what is still being worked out about it (its notes, and every code the sheet wrote against it). */
  interface Draft { m: PlannedMaterial; notes: string[]; codes: string[] }
  const drafts: Draft[] = [];
  let merged = 0;
  for (const [key, rows] of groups) {
    const first = rows[0]!;
    const same = rows.filter((r) => r.unit === first.unit);
    for (const r of rows.filter((x) => x.unit !== first.unit)) heldBack.push({ line: r.row.line, reason: `Same name as another row but a different unit (${r.unit} and ${first.unit})`, row: r.row });
    merged += same.length - 1;
    const counted = same.some((r) => r.qty !== null) ? same.reduce((a, r) => a + (r.qty ?? 0), 0) : null;
    const flags: string[] = [];
    if (first.replaceNamed) flags.push('no description on the sheet: named replace and a number');
    if (same.some((r) => r.unitGuessed)) flags.push(`the sheet does not give the unit; every ${first.category} row is in ${first.unit}, so that was used`);
    for (const r of same) if (r.unitFlag && !flags.includes(r.unitFlag)) flags.push(r.unitFlag);
    if (counted === null) flags.push('no quantity on the sheet: left uncounted');
    const places = new Set(same.map((r) => [r.row.rack, r.row.shelf].filter(Boolean).join(' ')).filter(Boolean));
    const notes: string[] = [];
    if (places.size > 1) notes.push(`On the sheet at: ${same.map((r) => `${[r.row.rack, r.row.shelf].filter(Boolean).join(' ')} (${r.qty ?? 'no quantity'})`).join('; ')}`);
    const remarks = [...new Set(same.map((r) => r.row.remark).filter(Boolean))];
    if (remarks.length) notes.push(`Sheet remark: ${remarks.join('; ')}`);
    const codes = [...new Set(same.map((r) => r.code).filter(Boolean))];
    const kept = !!first.category && KEPT_IN_STOCK.has(first.category);
    const draft: Draft = {
      codes, notes,
      m: {
        name: first.name, itemCode: codes.length === 1 ? codes[0]! : null, category: first.category || null, uom: first.unit as Unit,
        stockType: kept ? 'STANDING' : 'PER_JOB', ...(kept ? { minimumLevel: 0 } : {}),
        rack: first.row.rack || null, shelf: first.row.shelf || null, notes: null, counted, lines: same.map((r) => r.row.line), flags,
      },
    };
    if (existing.nameKeys.has(key)) alreadyThere.push(draft.m); else drafts.push(draft);
  }

  // 4. An item code is unique in the database. A code that sits on rows with different descriptions is the sheet's mistake
  //    somewhere and nobody can tell which row owns it, so none of them gets it; it is written in the note instead.
  const owners = new Map<string, number>();
  for (const d of drafts) for (const c of d.codes) owners.set(itemCodeKey(c), (owners.get(itemCodeKey(c)) ?? 0) + 1);
  let codeShared = 0;
  const materials = drafts.map(({ m, notes, codes }) => {
    const shared = codes.length > 1 || codes.some((c) => (owners.get(itemCodeKey(c)) ?? 0) > 1 || existing.itemCodeKeys.has(itemCodeKey(c)));
    if (shared) {
      codeShared++;
      m.itemCode = null;
      notes.push(`Code on the sheet: ${codes.join(', ')} (also on other rows, so not used as the item code)`);
      m.flags.push("the sheet's part number is shared with other rows: not used as the item code");
    }
    m.notes = notes.join('. ').slice(0, 500) || null;
    return m;
  });

  return {
    materials, heldBack, skipped, alreadyThere,
    counts: {
      rows: itemRows, materials: materials.length, standing: materials.filter((m) => m.stockType === 'STANDING').length, perJob: materials.filter((m) => m.stockType === 'PER_JOB').length,
      replaceNamed: materials.filter((m) => /^replace\d+$/.test(m.name)).length, merged, withCode: materials.filter((m) => m.itemCode).length, codeShared,
      uncounted: materials.filter((m) => m.counted === null).length, zero: materials.filter((m) => m.counted === 0).length,
    },
  };
}
