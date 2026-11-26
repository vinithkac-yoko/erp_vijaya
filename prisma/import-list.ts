/**
 * Turns a list of materials (a sheet with the description in the first column and the part number in the second, such as the
 * store's tape list) into materials:
 *
 *   pnpm materials:list <file.xlsx | list.csv> --sheet Tape --category TAPE --unit NOS [--stock-type PER_JOB]
 *       [--report review.csv] [--write-data prisma/data/materials/NAME.json --source "its name"] [--apply]
 *
 * Without --apply nothing is saved to the database: it prints what each row becomes and what needs a person's eye, and with
 * --report / --write-data writes the review (for Excel) and the list kept with the code, which is added once at the next
 * start (src/server/tools/material-lists-startup.ts). With --apply it adds the materials now, through the Tool Gateway.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { planMaterialList } from '../src/server/tools/material-list';
import { toFile } from '../src/server/tools/stock-data';
import { addMaterials } from '../src/server/tools/stock-load';
import { readNameCodeSheet, SheetError } from '../src/server/tools/stock-sheet-file';
import type { Unit } from '../src/server/tools/stock-import';

const prisma = new PrismaClient();
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const has = (n: string) => process.argv.includes(n);
const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/\"/g, '""')}"` : s; };

async function main() {
  const file = process.argv[2];
  const unit = arg('--unit')?.toUpperCase() as Unit | undefined;
  if (!file || file.startsWith('--') || !arg('--sheet') || !arg('--category') || !unit || !['KG', 'NOS', 'MTR', 'LTR', 'ROLL', 'SET'].includes(unit)) {
    console.log('Usage: pnpm materials:list <file.xlsx | list.csv> --sheet NAME --category KIND --unit NOS|KG|MTR|LTR|ROLL|SET [--stock-type PER_JOB|STANDING] [--report review.csv] [--write-data path.json --source "name"] [--apply]');
    process.exit(1);
  }
  const rows = await readNameCodeSheet(file, arg('--sheet')!);
  const mats = await prisma.material.findMany({ select: { nameKey: true, itemCodeKey: true } });
  const existing = { nameKeys: new Set(mats.map((m) => m.nameKey)), itemCodeKeys: new Set(mats.flatMap((m) => (m.itemCodeKey ? [m.itemCodeKey] : []))), replaceCount: 0 };
  const stockType = (arg('--stock-type') ?? 'PER_JOB') as 'PER_JOB' | 'STANDING';
  const opts = { category: arg('--category')!.toUpperCase(), uom: unit, stockType, ...(stockType === 'STANDING' ? { minimumLevel: 5 } : {}) };
  const plan = planMaterialList(rows, opts, existing);
  const c = plan.counts;
  console.log([`Rows with something in them:        ${c.rows}`, `Materials to add:                   ${c.materials}`, `  with a part number (item code):   ${c.withCode}`, `  without one:                      ${c.withoutCode}`, `Rows added into another (same description): ${c.merged}`, `Part numbers on two descriptions (used for neither): ${c.codeShared}`, `Skipped (headings, totals):         ${plan.skipped.length}`, `Already in the list (left alone):   ${plan.alreadyThere.length}`].join('\n'));
  for (const s of plan.skipped) console.log(`  skipped line ${s.line}: "${s.description || s.code}" — ${s.reason}`);
  for (const m of plan.materials.filter((x) => x.flags.some((f) => f.startsWith("the sheet's")))) console.log(`  check: ${m.name} — ${m.notes}`);

  if (arg('--report')) {
    const out = [['Status', 'Sheet line(s)', 'Name', 'Item code', 'Kind', 'Unit', 'Things to check'], ...plan.materials.map((m) => [m.flags.length ? 'Check' : 'Ready', m.lines.join('+'), m.name, m.itemCode ?? '', m.category ?? '', m.uom, m.flags.join('; ')]), ...plan.skipped.map((s) => ['Skipped', s.line, s.description, s.code, '', '', s.reason])];
    writeFileSync(arg('--report')!, out.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
    console.log(`\nThe full list is in ${arg('--report')}`);
  }
  if (arg('--write-data')) {
    // from the sheet alone, whatever is already in this database
    const whole = planMaterialList(rows, opts);
    const out = arg('--write-data')!;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(toFile(whole.materials, arg('--source') ?? basename(file), new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)), null, 1) + '\n');
    console.log(`\nThe list for the start-up load is in ${out} (${whole.materials.length} materials). Nothing was saved to the database.`);
  }
  if (!has('--apply')) { if (!arg('--write-data')) console.log('\nNothing was saved. Add --apply to add them now.'); return; }
  const owner = await prisma.user.findFirst({ where: { role: 'OWNER', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } });
  if (!owner) throw new Error('There is no owner login to add these as.');
  await addMaterials(plan.materials, { userId: owner.id, name: owner.name, role: 'OWNER' }, (l) => console.log(l));
}

main().catch((e) => { console.error(e instanceof SheetError ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
