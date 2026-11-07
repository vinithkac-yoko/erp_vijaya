/**
 * Loads the store's stock sheet as the starting stock (milestone 13):
 *
 *   pnpm stock:import <file.xlsx | stock.csv> [--apply] [--as owner@email] [--date YYYY-MM-DD] [--report review.csv]
 *
 * (`--write-data prisma/data/opening-stock.json` writes the reviewed list for the start-up load instead of saving.)
 *
 * Without --apply nothing is saved: it prints what each row would become and what needs a person's eye, and (with --report)
 * writes the whole list to a CSV that can be opened in Excel. With --apply it saves THROUGH THE TOOL GATEWAY, the same way a
 * person's form would (one audit row each): every material with create_material, then the opening count is started and the
 * quantities are put on its sheet with save_count_sheet. It never submits the count: an opening count needs a rate for every
 * material with stock, and the sheet has none, so the count stays open until the rates are in.
 *
 * Safe to run again: materials already in the list are left alone, a count that is open is continued, and a quantity already
 * typed on the count sheet is never overwritten. The only reads that do not go through a tool are the names already in the
 * list (to avoid duplicates) and who the owner is.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { planStockImport, type Plan } from '../src/server/tools/stock-import';
import { toFile } from '../src/server/tools/stock-data';
import { STOCK_SHEET_DECISIONS } from '../src/server/tools/stock-decisions';
import { applyStockPlan } from '../src/server/tools/stock-load';
import { readStockSheet, SheetError } from '../src/server/tools/stock-sheet-file';

const prisma = new PrismaClient();

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (name: string) => process.argv.includes(name);
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

function writeReport(path: string, plan: Plan) {
  const rows: unknown[][] = [['Status', 'Sheet line(s)', 'Name', 'Item code', 'Kind', 'Unit', 'Kept as', 'Minimum', 'Rack', 'Shelf', 'Quantity', 'Things to check', 'Note saved with it']];
  for (const m of plan.materials) rows.push([m.flags.length ? 'Check' : 'Ready', m.lines.join('+'), m.name, m.itemCode ?? '', m.category ?? '', m.uom, m.stockType === 'STANDING' ? 'Kept in stock' : 'Bought per job', m.minimumLevel ?? '', m.rack ?? '', m.shelf ?? '', m.counted ?? '', m.flags.join('; '), m.notes ?? '']);
  for (const h of plan.heldBack) rows.push(['Held back', h.line, h.row.description, h.row.code, h.row.category, h.row.uom, '', '', h.row.rack, h.row.shelf, h.row.qty, h.reason, '']);
  for (const h of plan.skipped) rows.push(['Skipped', h.line, h.row.description, h.row.code, h.row.category, h.row.uom, '', '', h.row.rack, h.row.shelf, h.row.qty, h.reason, '']);
  writeFileSync(path, csv(rows));
}

function print(plan: Plan) {
  const c = plan.counts;
  const lines = [
    `Rows read from the sheet:                 ${c.rows}`,
    `Materials to add:                         ${c.materials}`,
    `  kept in stock (MISC and CONS):          ${c.standing}   (minimum level 5 for now: the owner sets the real ones)`,
    `  bought for each job (everything else):  ${c.perJob}`,
    `  with no description (replace1, 2 …):    ${c.replaceNamed}`,
    `  rows added into one (same description): ${c.merged}`,
    `  with an item code:                      ${c.withCode}   (${c.codeShared} had a part number shared with other rows, so none was used)`,
    `Counted at zero (NIL or 0):               ${c.zero}`,
    `No quantity on the sheet (left uncounted): ${c.uncounted}`,
    `Held back (need an answer):               ${plan.heldBack.length}`,
    `Skipped (not items):                      ${plan.skipped.length}`,
    `Already in the list (left alone):         ${plan.alreadyThere.length}`,
  ];
  console.log(lines.join('\n'));
  if (plan.heldBack.length) { console.log('\nHeld back:'); for (const h of plan.heldBack) console.log(`  line ${h.line}: ${h.row.description || '(no description)'} [${h.row.code || 'no code'}] — ${h.reason}`); }
  if (plan.skipped.length) { console.log('\nSkipped:'); for (const h of plan.skipped) console.log(`  line ${h.line}: "${h.row.description}" — ${h.reason}`); }
  const flagged = plan.materials.filter((m) => m.flags.some((f) => !f.startsWith('no description') && !f.startsWith('no quantity') && !f.startsWith("the sheet's part number")));
  if (flagged.length) { console.log('\nUnits to check:'); for (const m of flagged) console.log(`  ${m.name} [line ${m.lines.join('+')}] — ${m.flags.filter((f) => !f.startsWith('no description') && !f.startsWith('no quantity') && !f.startsWith("the sheet's part number")).join('; ')}`); }
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) { console.log('Usage: pnpm stock:import <file.xlsx | stock.csv> [--apply] [--as owner@email] [--date YYYY-MM-DD] [--report review.csv]'); process.exit(1); }
  const rows = await readStockSheet(file);

  const [mats, owner] = await Promise.all([
    prisma.material.findMany({ select: { nameKey: true, itemCodeKey: true, name: true } }),
    prisma.user.findFirst({ where: { role: 'OWNER', isActive: true, ...(arg('--as') ? { email: arg('--as')!.toLowerCase() } : {}) }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } }),
  ]);
  const replaceCount = Math.max(0, ...mats.map((m) => Number(/^replace(\d+)$/i.exec(m.name)?.[1] ?? 0)));
  const plan = planStockImport(rows, { nameKeys: new Set(mats.map((m) => m.nameKey)), itemCodeKeys: new Set(mats.flatMap((m) => (m.itemCodeKey ? [m.itemCodeKey] : []))), replaceCount }, STOCK_SHEET_DECISIONS);
  print(plan);
  if (arg('--report')) { writeReport(arg('--report')!, plan); console.log(`\nThe full list is in ${arg('--report')}`); }

  // the opening stock as a plain list kept with the code, loaded once at start-up (docs/DEPLOY.md)
  if (arg('--write-data')) {
    const out = arg('--write-data')!;
    mkdirSync(dirname(out), { recursive: true });
    // from the sheet alone, whatever is already in this database
    const whole = planStockImport(rows, undefined, STOCK_SHEET_DECISIONS);
    writeFileSync(out, JSON.stringify(toFile(whole.materials, arg('--source') ?? basename(file), today()), null, 1) + '\n');
    console.log(`\nThe stock list for the start-up load is in ${out} (${whole.materials.length} materials). Nothing was saved to the database.`);
  }
  if (!has('--apply')) { if (!arg('--write-data')) console.log('\nNothing was saved. Add --apply to save it.'); return; }
  if (!owner) throw new Error('There is no owner login to save this as. Run the first-time setup, or name one with --as.');
  console.log('\nSaving …');
  await applyStockPlan(plan, { userId: owner.id, name: owner.name, role: 'OWNER' }, arg('--date') ?? today(), (line) => console.log(line));
}

main().catch((e) => { console.error(e instanceof SheetError ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
