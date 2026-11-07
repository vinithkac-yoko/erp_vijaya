import { materialNameKey } from '@/lib/names';
import { db } from '../db';
import { pendingActions, runTool } from './index';
import type { Plan } from './stock-import';
import type { ToolSession } from './types';

/**
 * Saves a reviewed stock plan THROUGH THE TOOL GATEWAY, the way a person's forms would: every material with create_material
 * (one audit row each), then the opening count is started with start_stock_count and the quantities go on its sheet with
 * save_count_sheet. It never submits the count (an opening count needs a rate for every material with stock, and the sheet has
 * none). Safe to run again: a material already in the list is not made twice, a count that is open is continued, and a quantity
 * somebody already typed on the sheet is never overwritten.
 */
type Data = Record<string, unknown>;

async function act(who: ToolSession, tool: string, input: Data): Promise<{ ok: true; data: Data } | { ok: false; message: string }> {
  const form = await pendingActions.create(who, { tool, origin: 'LAUNCHER' });
  if (!form.ok) return { ok: false, message: form.message };
  const r = await runTool(who, tool, input, { confirmation: form.data.id });
  return r.ok ? { ok: true, data: (r.data ?? {}) as Data } : { ok: false, message: r.message };
}

export interface LoadResult { made: number; refused: string[]; countNumber: string | null; countApproved: boolean; quantitiesSaved: number; counted: number; total: number; needRate: number }

export async function applyStockPlan(plan: Pick<Plan, 'materials' | 'alreadyThere'>, owner: ToolSession, date: string, say: (line: string) => void = () => {}): Promise<LoadResult> {
  const refused: string[] = [];
  let made = 0;
  for (const m of plan.materials) {
    const r = await act(owner, 'create_material', {
      name: m.name, uom: m.uom, stockType: m.stockType, ...(m.minimumLevel !== undefined ? { minimumLevel: m.minimumLevel } : {}),
      ...(m.itemCode ? { itemCode: m.itemCode } : {}), ...(m.category ? { category: m.category } : {}), ...(m.rack ? { rack: m.rack } : {}), ...(m.shelf ? { shelf: m.shelf } : {}),
      ...(m.notes ? { notes: m.notes } : {}), confirmNotDuplicate: true,
    });
    if (r.ok) { made++; if (made % 100 === 0) say(`  … ${made} materials added`); } else refused.push(`${m.name}: ${r.message}`);
  }
  say(`Materials added: ${made} of ${plan.materials.length}${refused.length ? ` (${refused.length} refused)` : ''}`);
  for (const f of refused) say(`  refused: ${f}`);

  const result: LoadResult = { made, refused, countNumber: null, countApproved: false, quantitiesSaved: 0, counted: 0, total: 0, needRate: 0 };

  // the opening count: continue the one that is open, start one if there is none, and say so if it is already approved
  const opening = await db.stockCount.findFirst({ where: { isOpening: true }, orderBy: { createdAt: 'desc' }, select: { status: true, number: true } });
  if (opening?.status === 'APPROVED') {
    say(`The opening count (${opening.number}) is already approved, so the quantities cannot be added to it. The materials were added.`);
    return { ...result, countNumber: opening.number, countApproved: true };
  }
  if (!opening) {
    const s = await act(owner, 'start_stock_count', { countDate: date, isOpening: true });
    if (!s.ok) { say(`Could not start the opening count: ${s.message}`); return result; }
    result.countNumber = String(s.data.number);
    say(`Opening count started: ${result.countNumber}`);
  } else { result.countNumber = opening.number; say(`Continuing the opening count ${opening.number}.`); }

  const sheet = await runTool(owner, 'list_count_lines', {});
  if (!sheet.ok) { say(`Could not read the count sheet: ${sheet.message}`); return result; }
  const data = sheet.data as { count: { id: string }; rows: { id: string; material: string; countedQty: number | null }[] };
  const lineOf = new Map(data.rows.map((r) => [materialNameKey(r.material), r]));
  const todo: { stockCountLineId: string; countedQty: number }[] = [];
  for (const m of [...plan.materials, ...plan.alreadyThere]) {
    const line = lineOf.get(materialNameKey(m.name));
    if (line && line.countedQty === null && m.counted !== null) todo.push({ stockCountLineId: line.id, countedQty: m.counted });
  }
  for (let i = 0; i < todo.length; i += 200) {
    const batch = todo.slice(i, i + 200);
    const r = await act(owner, 'save_count_sheet', { stockCountId: data.count.id, lines: batch });
    if (r.ok) { result.quantitiesSaved += batch.length; say(`  … ${result.quantitiesSaved} of ${todo.length} quantities on the count sheet`); continue; }
    // one bad line refuses its whole batch, so the batch is tried again a line at a time and only the bad one is left out
    for (const one of batch) {
      const x = await act(owner, 'save_count_sheet', { stockCountId: data.count.id, lines: [one] });
      if (x.ok) result.quantitiesSaved++; else { result.refused.push(x.message); say(`  refused: ${x.message}`); }
    }
    say(`  … ${result.quantitiesSaved} of ${todo.length} quantities on the count sheet`);
  }
  const after = await runTool(owner, 'list_count_lines', {});
  if (after.ok) {
    const d = after.data as { counted: number; total: number; rows: { countedQty: number | null; unitRate: number | null }[] };
    result.counted = d.counted; result.total = d.total;
    result.needRate = d.rows.filter((r) => (r.countedQty ?? 0) > 0 && !r.unitRate).length;
    say(`\nThe count sheet: ${d.counted} of ${d.total} counted. ${result.needRate} materials with stock still need a rate from their last purchase invoice before the count can be sent to the owner.`);
  }
  return result;
}
