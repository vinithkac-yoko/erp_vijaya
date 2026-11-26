import { itemCodeKey, materialNameKey, normalizeGstin, partNumberKey, partyNameKey } from '@/lib/names';
import { isSimilar, materialProfile } from '@/lib/similar';
import { quantityOf, unitOf, KEPT_IN_STOCK_MINIMUM, type Unit } from '../stock-import';
import { pickSheet } from './store';
import type { Content } from './files';
import { FIELDS, type Answers, type Grid, type Held, type Kind, type Option, type Plan, type Question, type Snapshot, type Spec, type Step, type TableSpec } from './types';

/**
 * The planners (milestone 16): given what the assistant said each table is (the Spec), every row of those tables, what is in the
 * database now, and what the owner has answered, work out the changes. Pure: nothing is read or saved here.
 *
 * Rules that hold for every kind:
 *  - Nothing in the database is ever changed without the owner saying so: where the sheet gives a value that is DIFFERENT from
 *    the system's, it is a question. A blank in the system that the sheet fills is not an overwrite, so it is just done and said.
 *  - A question that is not answered yet leaves its rows out of the plan (and the plan cannot be applied while any is open).
 *  - A unit is never guessed (it cannot be changed later): from the sheet, a default the owner agreed to, or a question.
 *  - A row that cannot be understood is held back with the reason, never skipped without a word.
 */
const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const colIndex = (letters: string) => letters.toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
export const letterOf = (i: number) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** The rows of the sheet a table is on, or why it can't be found. */
export function gridFor(content: Content, t: TableSpec, filename: string): Grid | string {
  if (content.sheets.length === 0) return `${filename} has no table in it to read (it is text only).`;
  const s = pickSheet(content, t.sheet);
  if (!s) return t.sheet ? `${filename} has no sheet called "${t.sheet}" (it has: ${content.sheets.map((x) => x.name).join(', ')}).` : `${filename} has more than one sheet (${content.sheets.map((x) => x.name).join(', ')}): say which one.`;
  return { uploadId: t.uploadId, filename, sheet: s.name, rows: s.rows };
}

/** Plain-words problems with a spec (before any planning). Empty = fine. */
export function specProblems(spec: Spec, grids: (Grid | string)[]): string[] {
  const out: string[] = [];
  spec.tables.forEach((t, i) => {
    const g = grids[i];
    const label = `Table ${i + 1} (${t.kind})`;
    if (g === undefined) return;
    if (typeof g === 'string') { out.push(`${label}: ${g}`); return; }
    const known = new Map(FIELDS[t.kind].map((f) => [f.name, f]));
    for (const f of Object.keys(t.columns)) if (!known.has(f)) out.push(`${label}: "${f}" is not a field of ${t.kind}. The fields are: ${[...known.keys()].join(', ')}.`);
    for (const f of Object.keys(t.defaults ?? {})) if (!known.has(f)) out.push(`${label}: "${f}" is not a field of ${t.kind} (in defaults).`);
    for (const f of known.values()) if (f.required && !(f.name in t.columns) && !(t.defaults && f.name in t.defaults)) out.push(`${label}: say which column holds the ${f.help} (${f.name}).`);
    const width = g.rows[0]?.length ?? 0;
    for (const [f, c] of Object.entries(t.columns)) if (colIndex(c) >= width) out.push(`${label}: column ${c.toUpperCase()} (${f}) is past the end of the sheet "${g.sheet}", which has ${width} columns (A to ${letterOf(Math.max(0, width - 1))}).`);
    if (t.headerRow > g.rows.length) out.push(`${label}: the heading row ${t.headerRow} is past the end of the sheet (${g.rows.length} rows).`);
  });
  return out;
}

interface Rec { row: number; v: Record<string, string> }
function recordsOf(t: TableSpec, g: Grid): Rec[] {
  const skip = new Set(t.skipRows ?? []);
  const out: Rec[] = [];
  const last = Math.min(t.lastRow ?? g.rows.length, g.rows.length);
  for (let r = t.headerRow + 1; r <= last; r++) {
    if (skip.has(r)) continue;
    const cells = g.rows[r - 1] ?? [];
    const v: Record<string, string> = {};
    let any = false;
    for (const f of FIELDS[t.kind]) {
      const c = t.columns[f.name];
      const cell = c ? clean(cells[colIndex(c)]) : '';
      if (cell) any = true;
      v[f.name] = cell || clean(t.defaults?.[f.name]);
    }
    if (any) out.push({ row: r, v });
  }
  return out;
}

// ── questions ───────────────────────────────────────────────────────────────────────────────────────
interface Def { text: (n: number) => string; options: Option[]; suggested: string }
class Questions {
  private m = new Map<string, Def & { items: string[]; examples: string[] }>();
  constructor(private answers: Answers) {}
  /** The owner's choice for this item, or undefined (and the item is added to the question) if it has not been answered. */
  decide(key: string, item: string, def: Def, example?: string): string | undefined {
    const a = this.answers[key];
    const choice = a ? a.perItem?.[item] ?? a.choice : undefined;
    if (choice !== undefined && def.options.some((o) => o.value === choice)) return choice;
    const q = this.m.get(key) ?? this.m.set(key, { ...def, items: [], examples: [] }).get(key)!;
    q.items.push(item);
    if (example && q.examples.length < 4) q.examples.push(example);
    return undefined;
  }
  open(): Question[] { return [...this.m].map(([key, q]) => ({ key, text: q.text(q.items.length), items: q.items.slice(0, 200), itemCount: q.items.length, examples: q.examples, options: q.options, suggested: q.suggested })); }
  pending(): number { return new Set([...this.m.values()].flatMap((q) => q.items)).size; }
}

const SHEET_OR_SYSTEM = (what: string, many: string): Def => ({
  text: (n) => `${n} ${n === 1 ? many.replace(/s$/, '') : many} already in the system ${n === 1 ? 'has' : 'have'} a different ${what} on the sheet. Which should be used?`,
  options: [{ value: 'system', label: 'Keep what the system has' }, { value: 'sheet', label: "Use the sheet's" }], suggested: 'system',
});

interface Ctx {
  snap: Snapshot; q: Questions; steps: Step[]; held: Held[]; notes: string[];
  newMaterials: Set<string>; newCustomers: Map<string, string>; newParts: Map<string, { customerName: string; partNumber: string }>;
  counts: Record<string, number>;
}
const bump = (c: Ctx, k: string, n = 1) => { c.counts[k] = (c.counts[k] ?? 0) + n; };
const hold = (c: Ctx, g: Grid, row: number, item: string, reason: string) => { c.held.push({ sheet: `${g.filename} · ${g.sheet}`, row, item, reason }); bump(c, 'held'); };
const num = (s: string) => { const n = Number(s.replace(/[,₹\s]/g, '')); return s !== '' && Number.isFinite(n) ? n : null; };
const same = (a: unknown, b: unknown) => (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : clean(a).toLowerCase() === clean(b).toLowerCase());

// ── materials ───────────────────────────────────────────────────────────────────────────────────────
const STOCK_WORDS = (s: string): 'STANDING' | 'PER_JOB' | null => {
  const t = s.toLowerCase();
  if (/^(standing|stock|kept|kept in stock|in stock|yes)$/.test(t)) return 'STANDING';
  if (/^(per_job|per job|job|bought for each job|no)$/.test(t)) return 'PER_JOB';
  return null;
};

function planMaterials(t: TableSpec, g: Grid, c: Ctx) {
  interface Row { row: number; name: string; code: string; unit: Unit | null; unitFlag?: string; qty: number | null; category: string; rack: string; shelf: string; min: number | null; stock: 'STANDING' | 'PER_JOB' | null; notes: string; hsn: string; gst: number | null }
  const rows: Row[] = [];
  for (const { row, v } of recordsOf(t, g)) {
    c.counts.rows = (c.counts.rows ?? 0) + 1;
    const name = clean(v.name).slice(0, 120);
    if (!name) { hold(c, g, row, v.itemCode || '(no name)', 'There is no name on this row'); continue; }
    if (clean(v.name).length > 120) c.notes.push(`"${name}" was cut to 120 letters.`);
    const q = quantityOf(v.quantity ?? '');
    if (q.bad) { hold(c, g, row, name, `The quantity "${v.quantity}" is not a number`); continue; }
    const min = v.minimumLevel ? num(v.minimumLevel) : null;
    if (v.minimumLevel && min === null) { hold(c, g, row, name, `The minimum level "${v.minimumLevel}" is not a number`); continue; }
    const gst = v.gstRate ? num(v.gstRate.replace('%', '')) : null;
    if (v.gstRate && (gst === null || gst < 0 || gst > 100)) { hold(c, g, row, name, `The GST rate "${v.gstRate}" is not a number`); continue; }
    const fromCol = v.unit ? unitOf(v.unit.replace(/^\d+\s*/, '')) : null;
    const u = q.unit ?? fromCol;
    const category = clean(v.category).toUpperCase();
    const stock = STOCK_WORDS(clean(v.stockType)) ?? (t.standingCategories?.length && category ? (t.standingCategories.map((x) => x.toUpperCase()).includes(category) ? 'STANDING' : 'PER_JOB') : null);
    if (q.qty !== null && !Number.isInteger(q.qty) && u && (u.unit === 'NOS' || u.unit === 'SET')) { hold(c, g, row, name, `The quantity ${q.qty} has a fraction but the unit is pieces (is it kilos?)`); continue; }
    rows.push({ row, name, code: clean(v.itemCode).slice(0, 40), unit: u?.unit ?? null, unitFlag: u?.flag, qty: q.qty, category, rack: clean(v.rack).slice(0, 20), shelf: clean(v.shelf).slice(0, 20), min, stock, notes: clean(v.notes), hsn: clean(v.hsnCode).slice(0, 20), gst });
  }

  // the same name on several rows is one material (the system holds one of each): quantities add up
  const groups = new Map<string, Row[]>();
  for (const r of rows) (groups.get(materialNameKey(r.name)) ?? groups.set(materialNameKey(r.name), []).get(materialNameKey(r.name))!).push(r);
  const byKey = new Map(c.snap.materials.map((m) => [m.nameKey, m]));
  const codeOwner = new Map(c.snap.materials.filter((m) => m.itemCodeKey).map((m) => [m.itemCodeKey as string, m.name]));
  // a part number written against different names is given to none of them (nobody can tell which owns it)
  const namesOfCode = new Map<string, Set<string>>();
  for (const [key, rs] of groups) for (const code of new Set(rs.map((r) => r.code).filter(Boolean))) (namesOfCode.get(itemCodeKey(code)) ?? namesOfCode.set(itemCodeKey(code), new Set()).get(itemCodeKey(code))!).add(key);

  const similarPool = c.snap.materials.filter((m) => m.isActive).map((m) => ({ m, p: materialProfile(m.name) }));
  const quantityItems: { name: string; qty: number; previous: number | null }[] = [];
  const count = c.snap.count;
  let countBlocked: string | null = null;
  if (count?.status === 'PENDING_APPROVAL') countBlocked = `The opening count (${count.number}) is waiting for your approval, so no quantities can be added to it. Send it back first (it is not lost), then add them.`;
  if (count?.status === 'APPROVED') countBlocked = `The opening count (${count.number}) is already approved, so quantities cannot be put on it from a file. (Later stock comes from goods receipts and counts.)`;
  let blockedNoted = false;

  for (const [key, rs] of groups) {
    const first = rs[0]!;
    const units = new Set(rs.map((r) => r.unit).filter(Boolean));
    if (units.size > 1) { for (const r of rs) hold(c, g, r.row, r.name, `The same name is on more than one row with different units (${[...units].join(', ')})`); continue; }
    const unit = (rs.find((r) => r.unit)?.unit ?? null) as Unit | null;
    const qtys = rs.filter((r) => r.qty !== null);
    const qty = qtys.length ? qtys.reduce((a, r) => a + (r.qty ?? 0), 0) : null;
    const pick = <T,>(f: (r: Row) => T, empty: (x: T) => boolean) => rs.map(f).find((x) => !empty(x));
    const rack = pick((r) => r.rack, (x) => !x) ?? '', shelf = pick((r) => r.shelf, (x) => !x) ?? '', category = pick((r) => r.category, (x) => !x) ?? '';
    const codes = [...new Set(rs.map((r) => r.code).filter(Boolean))];
    const min = rs.find((r) => r.min !== null)?.min ?? null, hsn = pick((r) => r.hsn, (x) => !x) ?? '', gst = rs.find((r) => r.gst !== null)?.gst ?? null;
    const places = new Set(rs.map((r) => [r.rack, r.shelf].filter(Boolean).join(' ')).filter(Boolean));
    const noteParts = [...new Set(rs.map((r) => r.notes).filter(Boolean))];
    if (places.size > 1) noteParts.unshift(`On the sheet at: ${rs.map((r) => `${[r.rack, r.shelf].filter(Boolean).join(' ')} (${r.qty ?? 'no quantity'})`).join('; ')}`);
    if (rs.length > 1) bump(c, 'merged', rs.length - 1);

    const exists = byKey.get(key);
    if (exists) {
      if (!exists.isActive) { c.notes.push(`"${exists.name}" is stopped (no longer in use), so it was left alone.`); continue; }
      if (unit && unit !== exists.uom) c.notes.push(`"${exists.name}": the sheet says ${unit} but the system counts it in ${exists.uom}. A unit can never be changed, so it stays ${exists.uom}.`);
      const changes: Record<string, unknown> = {}, before: Record<string, unknown> = {};
      const field = (f: 'itemCode' | 'category' | 'rack' | 'shelf' | 'minimumLevel' | 'hsnCode' | 'gstRate', sheetVal: string | number | null, dbVal: string | number | null, label: string) => {
        if (sheetVal === null || sheetVal === '') return;
        if (dbVal === null || dbVal === '') { changes[f] = sheetVal; before[f] = null; bump(c, 'filled'); return; }
        if (same(sheetVal, dbVal)) return;
        const d = c.q.decide(`materials.${f}`, exists.name, SHEET_OR_SYSTEM(label, 'materials'), `${exists.name}: system ${dbVal}, sheet ${sheetVal}`);
        if (d === 'sheet') { changes[f] = sheetVal; before[f] = dbVal; bump(c, 'changed'); }
      };
      const codeFree = (cd: string) => { const o = codeOwner.get(itemCodeKey(cd)); return !o || materialNameKey(o) === key; };
      const code = codes.length === 1 && (namesOfCode.get(itemCodeKey(codes[0]!))?.size ?? 0) === 1 ? codes[0]! : '';
      if (code && !codeFree(code)) c.notes.push(`"${exists.name}": the part number ${code} belongs to "${codeOwner.get(itemCodeKey(code))}" in the system, so it was not used.`);
      else field('itemCode', code, exists.itemCode, 'part number');
      field('category', category, exists.category, 'kind');
      field('rack', rack, exists.rack, 'rack'); field('shelf', shelf, exists.shelf, 'shelf');
      if (exists.stockType === 'STANDING') field('minimumLevel', min, exists.minimumLevel, 'minimum level');
      field('hsnCode', hsn, exists.hsnCode, 'HSN code'); field('gstRate', gst, exists.gstRate, 'GST rate');
      if (Object.keys(changes).length) c.steps.push({ key: `m:${key}`, area: 'materials', tool: 'update_material', label: `Update ${exists.name}: ${Object.entries(changes).map(([k, v]) => `${k} ${v}`).join(', ')}`, input: { materialId: exists.id, ...changes }, before });
      else bump(c, 'unchanged');
      if (qty !== null) {
        if (countBlocked) { if (!blockedNoted) { c.notes.push(countBlocked); blockedNoted = true; } }
        else {
          const line = count?.lines.get(key);
          if (!line || line.countedQty === null) quantityItems.push({ name: exists.name, qty, previous: null });
          else if (Number(line.countedQty) !== qty) {
            const d = c.q.decide('quantities.differs', exists.name, { text: (n) => `${n} ${n === 1 ? 'material has' : 'materials have'} a quantity on the opening count that is different from the sheet. Which should be used?`, options: [{ value: 'system', label: 'Keep the count as it is' }, { value: 'sheet', label: "Use the sheet's quantity" }], suggested: 'system' }, `${exists.name}: count ${line.countedQty}, sheet ${qty}`);
            if (d === 'sheet') quantityItems.push({ name: exists.name, qty, previous: Number(line.countedQty) });
          }
        }
      }
      continue;
    }

    // a new material: it needs a unit and a way of being bought
    const unitChoice = unit ?? c.q.decide('materials.unit', first.name, {
      text: (n) => `The sheet does not give the unit for ${n} ${n === 1 ? 'material' : 'materials'}, and a unit can never be changed once a material is made. Which unit?`,
      options: [...(['NOS', 'KG', 'MTR', 'LTR', 'ROLL', 'SET'] as const).map((u) => ({ value: u, label: { NOS: 'Pieces (nos)', KG: 'Kilograms (kg)', MTR: 'Metres (mtr)', LTR: 'Litres (ltr)', ROLL: 'Rolls', SET: 'Sets' }[u] })), { value: 'hold', label: 'Leave these out for now' }], suggested: 'NOS',
    });
    if (unitChoice === undefined) continue; // waiting for the answer
    if (unitChoice === 'hold') { hold(c, g, first.row, first.name, 'The unit was not given, and you chose to leave it out for now'); continue; }
    const resolvedUnit = unitChoice as Unit;
    const stock = rs.find((r) => r.stock)?.stock ?? (t.defaults?.stockType ? STOCK_WORDS(t.defaults.stockType) : null) ?? ((): 'STANDING' | 'PER_JOB' | undefined => {
      const d = c.q.decide('materials.stockType', first.name, { text: (n) => `Is each of these ${n} new ${n === 1 ? 'material' : 'materials'} kept in stock (with a minimum level) or bought for each job?`, options: [{ value: 'PER_JOB', label: 'Bought for each job' }, { value: 'STANDING', label: `Kept in stock (minimum level ${KEPT_IN_STOCK_MINIMUM} until you set the real one)` }], suggested: 'PER_JOB' });
      return d as 'STANDING' | 'PER_JOB' | undefined;
    })();
    if (!stock) continue;

    let itemCode: string | null = codes.length === 1 ? codes[0]! : null;
    if (codes.length > 1) { noteParts.push(`Part numbers on the sheet: ${codes.join(', ')}`); itemCode = null; }
    if (itemCode && (namesOfCode.get(itemCodeKey(itemCode))?.size ?? 0) > 1) { noteParts.push(`Part number on the sheet: ${itemCode} (also on other names, so not used as the item code)`); bump(c, 'codeShared'); itemCode = null; }
    if (itemCode && codeOwner.has(itemCodeKey(itemCode))) { noteParts.push(`Part number on the sheet: ${itemCode} (already used for another material)`); bump(c, 'codeShared'); itemCode = null; }

    // a name that is nearly the same as one already there is asked about (the system refuses near-duplicates unless told)
    const near = similarPool.find((x) => isSimilar(materialProfile(first.name), x.p));
    if (near) {
      const d = c.q.decide('materials.similar', first.name, { text: (n) => `${n} new ${n === 1 ? 'name looks' : 'names look'} like ${n === 1 ? 'a material' : 'materials'} that ${n === 1 ? 'is' : 'are'} already in the system. Add ${n === 1 ? 'it' : 'them'} as new materials anyway?`, options: [{ value: 'skip', label: 'No, they are the same: leave them out' }, { value: 'add', label: 'Yes, add them as new materials' }], suggested: 'skip' }, `${first.name} ~ ${near.m.name}`);
      if (d !== 'add') continue;
    }
    c.newMaterials.add(key);
    const input: Record<string, unknown> = { name: first.name, uom: resolvedUnit, stockType: stock, confirmNotDuplicate: true };
    if (stock === 'STANDING') input.minimumLevel = min ?? KEPT_IN_STOCK_MINIMUM;
    if (itemCode) input.itemCode = itemCode;
    if (category) input.category = category;
    if (rack) input.rack = rack;
    if (shelf) input.shelf = shelf;
    if (hsn) input.hsnCode = hsn;
    if (gst !== null) input.gstRate = gst;
    if (noteParts.length) input.notes = noteParts.join('. ').slice(0, 500);
    c.steps.push({ key: `m:${key}`, area: 'materials', tool: 'create_material', label: `Add ${first.name} (${resolvedUnit})`, input });
    bump(c, 'new');
    if (qty !== null) { if (countBlocked) { if (!blockedNoted) { c.notes.push(countBlocked); blockedNoted = true; } } else quantityItems.push({ name: first.name, qty, previous: null }); }
  }
  if (quantityItems.length) c.steps.push({ key: `q:${t.uploadId}:${c.steps.length}`, area: 'quantities', tool: 'set_opening_quantities', label: `Put the quantities of ${quantityItems.length} materials on the opening count${count ? '' : ' (it is started first)'}`, input: { items: quantityItems, startIfMissing: !count }, before: { items: quantityItems.map((x) => ({ name: x.name, previous: x.previous })) } });
  bump(c, 'quantities', quantityItems.length);
}

// ── parties ─────────────────────────────────────────────────────────────────────────────────────────
const ROLE_WORDS = (s: string): 'SUPPLIER' | 'CUSTOMER' | 'BOTH' | null => {
  const t = s.toLowerCase().replace(/[^a-z]/g, '');
  if (/^(supplier|vendor|seller|supply)$/.test(t)) return 'SUPPLIER';
  if (/^(customer|buyer|client)$/.test(t)) return 'CUSTOMER';
  if (/^(both|supplierandcustomer|customerandsupplier)$/.test(t)) return 'BOTH';
  return null;
};
const GSTIN_OK = /^[0-9A-Z]{15}$/;
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digits = (s: string) => s.replace(/\D/g, '');

function planParties(t: TableSpec, g: Grid, c: Ctx) {
  interface P { row: number; name: string; role: 'SUPPLIER' | 'CUSTOMER' | 'BOTH' | null; f: Record<'gstin' | 'city' | 'state' | 'addressLine' | 'pincode' | 'phone' | 'email', string> }
  const groups = new Map<string, P[]>();
  for (const { row, v } of recordsOf(t, g)) {
    bump(c, 'rows');
    const name = clean(v.name);
    if (!name) { hold(c, g, row, '(no name)', 'There is no business name on this row'); continue; }
    if (name.length > 150) { hold(c, g, row, name.slice(0, 40), 'The name is too long (150 letters at most)'); continue; }
    const gstin = v.gstin ? normalizeGstin(v.gstin) : '';
    if (gstin && !GSTIN_OK.test(gstin)) { hold(c, g, row, name, `The GSTIN "${v.gstin}" is not 15 letters and numbers`); continue; }
    if (v.email && !EMAIL_OK.test(v.email)) { hold(c, g, row, name, `"${v.email}" does not look like an email address`); continue; }
    if (v.role && !ROLE_WORDS(v.role)) { hold(c, g, row, name, `"${v.role}" is not supplier, customer or both`); continue; }
    const key = partyNameKey(name);
    if (!key) { hold(c, g, row, name, 'No usable name'); continue; }
    (groups.get(key) ?? groups.set(key, []).get(key)!).push({ row, name, role: ROLE_WORDS(v.role ?? ''), f: { gstin, city: clean(v.city).slice(0, 80), state: clean(v.state).slice(0, 80), addressLine: clean(v.address).slice(0, 200), pincode: clean(v.pincode).slice(0, 10), phone: clean(v.phone).slice(0, 30), email: clean(v.email).toLowerCase().slice(0, 120) } });
  }
  const byGstin = new Map(c.snap.parties.filter((p) => p.gstin).map((p) => [p.gstin as string, p]));
  const byKey = new Map(c.snap.parties.map((p) => [p.nameKey, p]));
  for (const [key, rs] of groups) {
    const first = rs[0]!;
    if (rs.length > 1) bump(c, 'merged', rs.length - 1);
    const f = { gstin: '', city: '', state: '', addressLine: '', pincode: '', phone: '', email: '' };
    for (const k of Object.keys(f) as (keyof typeof f)[]) {
      const vals = [...new Set(rs.map((r) => r.f[k]).filter(Boolean))];
      f[k] = vals[0] ?? '';
      if (vals.length > 1) c.notes.push(`"${first.name}" is on the sheet more than once with different ${k === 'addressLine' ? 'addresses' : k}; the first was used.`);
    }
    const sheetRoles = new Set(rs.map((r) => r.role).filter(Boolean));
    const role = sheetRoles.size === 1 ? [...sheetRoles][0]! : sheetRoles.size > 1 ? 'BOTH' : null;
    const exists = (f.gstin ? byGstin.get(f.gstin) : undefined) ?? byKey.get(key);
    if (exists) {
      if (!exists.isActive) { c.notes.push(`"${exists.name}" is stopped (no longer in use), so it was left alone.`); continue; }
      if (f.gstin && byGstin.get(f.gstin) && partyNameKey(byGstin.get(f.gstin)!.name) !== key) c.notes.push(`"${first.name}" has the same GSTIN as "${exists.name}", so they were treated as one business.`);
      const changes: Record<string, unknown> = {}, before: Record<string, unknown> = {};
      const field = (k: 'gstin' | 'city' | 'state' | 'addressLine' | 'pincode' | 'phone' | 'email', label: string) => {
        const sheetVal = f[k], dbVal = exists[k];
        if (!sheetVal) return;
        if (!dbVal) { changes[k] = sheetVal; before[k] = null; bump(c, 'filled'); return; }
        if (k === 'phone' ? digits(sheetVal) === digits(dbVal) : same(sheetVal, dbVal)) return;
        const d = c.q.decide(`parties.${k}`, exists.name, SHEET_OR_SYSTEM(label, 'businesses'), `${exists.name}: system ${dbVal}, sheet ${sheetVal}`);
        if (d === 'sheet') { changes[k] = sheetVal; before[k] = dbVal; bump(c, 'changed'); }
      };
      field('gstin', 'GSTIN'); field('city', 'city'); field('state', 'state'); field('addressLine', 'address'); field('pincode', 'PIN code'); field('phone', 'phone'); field('email', 'email');
      const wantSupplier = role === 'SUPPLIER' || role === 'BOTH', wantCustomer = role === 'CUSTOMER' || role === 'BOTH';
      const add = wantSupplier && !exists.isSupplier ? 'SUPPLIER' : wantCustomer && !exists.isCustomer ? 'CUSTOMER' : null;
      if (add) {
        const d = c.q.decide('parties.addRole', exists.name, { text: (n) => `${n} ${n === 1 ? 'business is' : 'businesses are'} saved as one kind (supplier or customer) but the sheet says ${n === 1 ? 'it is' : 'they are'} also the other. Add the role?`, options: [{ value: 'add', label: 'Yes, add the role' }, { value: 'skip', label: 'No, leave them as they are' }], suggested: 'add' }, `${exists.name}: also a ${add.toLowerCase()}`);
        if (d === 'add') { changes.addRole = add; before.addRole = null; bump(c, 'changed'); }
      }
      if (exists.isCustomer || add === 'CUSTOMER') c.newCustomers.set(key, exists.name);
      if (Object.keys(changes).length) c.steps.push({ key: `p:${key}`, area: 'parties', tool: 'update_party', label: `Update ${exists.name}: ${Object.entries(changes).map(([k, v]) => `${k} ${v}`).join(', ')}`, input: { partyId: exists.id, ...changes }, before });
      else bump(c, 'unchanged');
      continue;
    }
    const decided = role ?? ((): 'SUPPLIER' | 'CUSTOMER' | 'BOTH' | undefined => {
      const d = c.q.decide('parties.role', first.name, { text: (n) => `The sheet does not say whether ${n === 1 ? 'this business is' : `these ${n} businesses are`} suppliers (we buy from them) or customers (they buy from us).`, options: [{ value: 'SUPPLIER', label: 'Suppliers' }, { value: 'CUSTOMER', label: 'Customers' }, { value: 'BOTH', label: 'Both' }], suggested: 'SUPPLIER' });
      return d as 'SUPPLIER' | 'CUSTOMER' | 'BOTH' | undefined;
    })();
    if (!decided) continue;
    if (f.gstin && byGstin.has(f.gstin)) continue;
    const input: Record<string, unknown> = { name: first.name, role: decided, confirmNotDuplicate: true };
    for (const k of Object.keys(f) as (keyof typeof f)[]) if (f[k]) input[k] = f[k];
    c.steps.push({ key: `p:${key}`, area: 'parties', tool: 'create_party', label: `Add ${first.name} (${decided === 'BOTH' ? 'supplier and customer' : decided.toLowerCase()})`, input });
    if (decided !== 'SUPPLIER') c.newCustomers.set(key, first.name);
    bump(c, 'new');
  }
}

// ── parts ───────────────────────────────────────────────────────────────────────────────────────────
function customerNamed(c: Ctx, name: string): { name: string } | 'supplier' | null {
  const key = partyNameKey(name);
  const p = c.snap.parties.find((x) => x.nameKey === key);
  if (p && p.isActive && p.isCustomer) return { name: p.name };
  const planned = c.newCustomers.get(key);
  if (planned) return { name: planned };
  return p ? 'supplier' : null;
}

function planParts(t: TableSpec, g: Grid, c: Ctx) {
  interface R { row: number; customer: string; partNumber: string; description: string; hsn: string }
  const groups = new Map<string, R[]>();
  for (const { row, v } of recordsOf(t, g)) {
    bump(c, 'rows');
    const partNumber = clean(v.partNumber), description = clean(v.description), customerName = clean(v.customer);
    if (!partNumber) { hold(c, g, row, description || '(no part number)', 'There is no part number on this row'); continue; }
    if (!description) { hold(c, g, row, partNumber, 'There is no description on this row'); continue; }
    if (!customerName) { hold(c, g, row, partNumber, 'There is no customer on this row'); continue; }
    if (partNumber.length > 40 || description.length > 200) { hold(c, g, row, partNumber, 'The part number or description is too long'); continue; }
    const cust = customerNamed(c, customerName);
    if (cust === null) { hold(c, g, row, partNumber, `The customer "${customerName}" is not in the list. Add them as a customer first (or include them in this import)`); continue; }
    if (cust === 'supplier') { hold(c, g, row, partNumber, `"${customerName}" is saved as a supplier, not a customer`); continue; }
    const k = `${partyNameKey(cust.name)}|${partNumberKey(partNumber)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push({ row, customer: cust.name, partNumber, description, hsn: clean(v.hsnCode).slice(0, 20) });
  }
  for (const [k, rs] of groups) {
    const first = rs[0]!;
    if (rs.length > 1) bump(c, 'merged', rs.length - 1);
    if (new Set(rs.map((r) => r.description.toLowerCase())).size > 1) c.notes.push(`Part ${first.partNumber} (${first.customer}) is on the sheet with different descriptions; the first was used.`);
    const hsn = rs.find((r) => r.hsn)?.hsn ?? '';
    const label = `${first.partNumber} · ${first.customer}`;
    const exists = c.snap.parts.find((p) => p.customerName === first.customer && p.partKey === partNumberKey(first.partNumber));
    if (exists) {
      if (!exists.isActive) { c.notes.push(`Part ${label} is marked as no longer made, so it was left alone.`); continue; }
      const changes: Record<string, unknown> = {}, before: Record<string, unknown> = {};
      if (!same(first.description, exists.description)) {
        const d = c.q.decide('parts.description', label, SHEET_OR_SYSTEM('description', 'parts'), `${label}: system "${exists.description}", sheet "${first.description}"`);
        if (d === 'sheet') { changes.description = first.description; before.description = exists.description; bump(c, 'changed'); }
      }
      if (hsn) { if (!exists.hsnCode) { changes.hsnCode = hsn; before.hsnCode = null; bump(c, 'filled'); } else if (!same(hsn, exists.hsnCode)) {
        const d = c.q.decide('parts.hsnCode', label, SHEET_OR_SYSTEM('HSN code', 'parts'), `${label}: system ${exists.hsnCode}, sheet ${hsn}`);
        if (d === 'sheet') { changes.hsnCode = hsn; before.hsnCode = exists.hsnCode; bump(c, 'changed'); }
      } }
      if (Object.keys(changes).length) c.steps.push({ key: `t:${k}`, area: 'parts', tool: 'update_part', label: `Update part ${label}: ${Object.entries(changes).map(([x, v]) => `${x} ${v}`).join(', ')}`, input: { partId: exists.id, ...changes }, before });
      else bump(c, 'unchanged');
      continue;
    }
    c.steps.push({ key: `t:${k}`, area: 'parts', tool: 'create_part', label: `Add part ${label}`, input: { customerName: first.customer, partNumber: first.partNumber, description: first.description, ...(hsn ? { hsnCode: hsn } : {}) } });
    c.newParts.set(k, { customerName: first.customer, partNumber: first.partNumber });
    bump(c, 'new');
  }
}

// ── bills of materials ──────────────────────────────────────────────────────────────────────────────
function planBoms(t: TableSpec, g: Grid, c: Ctx) {
  interface L { row: number; material: string; qty: number }
  const parts = new Map<string, { label: string; customerName: string; partNumber: string; partId?: string; lines: L[]; bad: boolean }>();
  const mats = new Map(c.snap.materials.filter((m) => m.isActive).map((m) => [m.nameKey, m.name]));
  for (const { row, v } of recordsOf(t, g)) {
    bump(c, 'rows');
    const partNumber = clean(v.partNumber), materialName = clean(v.material), customer = clean(v.customer);
    if (!partNumber || !materialName) { hold(c, g, row, partNumber || materialName || '(empty)', 'The part number or the material is missing on this row'); continue; }
    const pk = partNumberKey(partNumber);
    // which part: an existing one or one this import adds
    const cands: { customerName: string; partNumber: string; id?: string }[] = [
      ...c.snap.parts.filter((p) => p.isActive && p.partKey === pk).map((p) => ({ customerName: p.customerName, partNumber: p.partNumber, id: p.id })),
      ...[...c.newParts.values()].filter((p) => partNumberKey(p.partNumber) === pk),
    ];
    const chosen = customer ? cands.filter((x) => partyNameKey(x.customerName) === partyNameKey(customer)) : cands;
    const partLabel = customer ? `${partNumber} · ${customer}` : partNumber;
    if (chosen.length === 0) { hold(c, g, row, partLabel, `There is no part ${partNumber}${customer ? ` for ${customer}` : ''} in the system (add the part first, or include it in this import)`); continue; }
    if (chosen.length > 1) { hold(c, g, row, partLabel, `${chosen.length} customers have a part ${partNumber}: say which customer`); continue; }
    const p = chosen[0]!;
    const key = `${partyNameKey(p.customerName)}|${pk}`;
    const entry = parts.get(key) ?? parts.set(key, { label: `${p.partNumber} · ${p.customerName}`, customerName: p.customerName, partNumber: p.partNumber, partId: p.id, lines: [], bad: false }).get(key)!;
    const qty = num(v.qtyPerPiece ?? '');
    if (qty === null || qty <= 0) { hold(c, g, row, `${entry.label} · ${materialName}`, `The quantity "${v.qtyPerPiece}" is not a number above zero`); entry.bad = true; continue; }
    const mkey = materialNameKey(materialName);
    const known = mats.get(mkey) ?? (c.newMaterials.has(mkey) ? materialName : undefined);
    if (!known) { hold(c, g, row, `${entry.label} · ${materialName}`, `"${materialName}" is not in the materials list (add the material first, or include it in this import)`); entry.bad = true; continue; }
    const dupe = entry.lines.find((l) => materialNameKey(l.material) === mkey);
    if (dupe) { dupe.qty += qty; c.notes.push(`${entry.label}: ${known} is on the sheet more than once; the amounts were added together.`); continue; }
    entry.lines.push({ row, material: known, qty });
  }
  for (const [key, p] of parts) {
    if (p.bad) { c.held.push({ sheet: `${g.filename} · ${g.sheet}`, row: p.lines[0]?.row ?? 0, item: p.label, reason: 'Left out whole, because some of its lines could not be matched (a part with half its materials would be worse than none)' }); bump(c, 'held'); continue; }
    if (p.lines.length > 60) { c.held.push({ sheet: `${g.filename} · ${g.sheet}`, row: p.lines[0]!.row, item: p.label, reason: 'More than 60 materials for one part' }); bump(c, 'held'); continue; }
    if (p.lines.length === 0) continue;
    const existing = p.partId ? c.snap.parts.find((x) => x.id === p.partId)!.bom : [];
    const lines = p.lines.map((l) => ({ materialName: l.material, qtyPerPiece: l.qty }));
    if (existing.length) {
      const now = new Map(existing.map((e) => [materialNameKey(e.materialName), e.qtyPerPiece]));
      const equal = now.size === lines.length && lines.every((l) => now.get(materialNameKey(l.materialName)) === l.qtyPerPiece);
      if (equal) { bump(c, 'unchanged'); continue; }
      const d = c.q.decide('boms.replace', p.label, { text: (n) => `${n} ${n === 1 ? 'part already has' : 'parts already have'} a usual bill of materials that is different from the sheet. Replace ${n === 1 ? 'it' : 'them'}?`, options: [{ value: 'system', label: 'Keep the ones in the system' }, { value: 'sheet', label: "Replace with the sheet's" }], suggested: 'system' }, `${p.label}: system has ${existing.length} materials, sheet has ${lines.length}`);
      if (d !== 'sheet') continue;
      c.steps.push({ key: `b:${key}`, area: 'boms', tool: 'set_part_bom', label: `Replace the usual bill of materials of ${p.label} (${lines.length} materials)`, input: { customerName: p.customerName, partNumber: p.partNumber, lines }, before: { lines: existing.map((e) => ({ materialName: e.materialName, qtyPerPiece: e.qtyPerPiece })) } });
      bump(c, 'changed');
    } else {
      c.steps.push({ key: `b:${key}`, area: 'boms', tool: 'set_part_bom', label: `Set the usual bill of materials of ${p.label} (${lines.length} materials)`, input: { customerName: p.customerName, partNumber: p.partNumber, lines }, before: { lines: [] } });
      bump(c, 'new');
    }
  }
}

// ── the whole plan ──────────────────────────────────────────────────────────────────────────────────
const ORDER: Kind[] = ['materials', 'parties', 'parts', 'bom'];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function planImport(spec: Spec, grids: Grid[], snap: Snapshot, answers: Answers): Plan {
  const c: Ctx = { snap, q: new Questions(answers), steps: [], held: [], notes: [], newMaterials: new Set(), newCustomers: new Map(), newParts: new Map(), counts: {} };
  // materials first, then businesses, parts and bills of materials: later tables can use what earlier ones add
  const tables = spec.tables.map((t, i) => ({ t, g: grids[i]!, i })).sort((a, b) => ORDER.indexOf(a.t.kind) - ORDER.indexOf(b.t.kind) || a.i - b.i);
  for (const { t, g } of tables) {
    if (t.kind === 'materials') planMaterials(t, g, c);
    else if (t.kind === 'parties') planParties(t, g, c);
    else if (t.kind === 'parts') planParts(t, g, c);
    else planBoms(t, g, c);
  }
  const areaOrder = ['materials', 'parties', 'parts', 'boms', 'quantities'];
  const steps = c.steps.sort((a, b) => areaOrder.indexOf(a.area) - areaOrder.indexOf(b.area));
  const questions = c.q.open();
  const by = (tool: Step['tool']) => steps.filter((s) => s.tool === tool).length;
  const lines: string[] = [];
  if (by('create_material')) lines.push(`Add ${plural(by('create_material'), 'new material')}`);
  if (by('update_material')) lines.push(`Change ${plural(by('update_material'), 'material')} that already exist (only what you agreed to, or blanks the sheet fills in)`);
  if (by('set_opening_quantities')) lines.push(`Put ${plural(c.counts.quantities ?? 0, 'quantity', 'quantities')} on the opening count`);
  if (by('create_party')) lines.push(`Add ${plural(by('create_party'), 'supplier or customer', 'suppliers or customers')}`);
  if (by('update_party')) lines.push(`Change ${plural(by('update_party'), 'supplier or customer', 'suppliers or customers')} that already exist`);
  if (by('create_part')) lines.push(`Add ${plural(by('create_part'), 'part')}`);
  if (by('update_part')) lines.push(`Change ${plural(by('update_part'), 'part')} that already exist`);
  if (by('set_part_bom')) lines.push(`Set the usual bill of materials of ${plural(by('set_part_bom'), 'part')}`);
  if ((c.counts.unchanged ?? 0) > 0) lines.push(`${(c.counts.unchanged ?? 0)} already match the system and need nothing`);
  if ((c.counts.merged ?? 0) > 0) lines.push(`${plural(c.counts.merged ?? 0, 'repeated row')} joined with the row they repeat`);
  if (c.held.length) lines.push(`${plural(c.held.length, 'row')} left out, with the reason`);
  if (questions.length) lines.push(`${plural(c.q.pending(), 'item')} waiting on ${plural(questions.length, 'answer')} from you`);
  if (!lines.length) lines.push('Nothing to change: everything on the sheet is already in the system.');
  return { steps, questions, held: c.held, notes: [...new Set(c.notes)], lines, counts: { ...c.counts, pending: c.q.pending() } };
}
