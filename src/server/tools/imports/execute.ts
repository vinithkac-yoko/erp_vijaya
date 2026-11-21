import { materialNameKey, partNumberKey, partyNameKey } from '@/lib/names';
import { db } from '../../db';
import type { ToolSession } from '../types';
import type { Step } from './types';

/**
 * Carrying out a plan, and undoing it (milestone 16). Every change goes through the Tool Gateway as the owner, one tool call per
 * change, the same way the owner's own forms would: so every rule the forms have still applies, and every change has its own
 * audit row. This file adds no way to write business data of its own.
 *
 * Before a change to something that already exists, it checks that thing is still as the plan saw it. If somebody changed it in
 * between, the change is skipped and said so, never forced.
 */
export interface StepResult { key: string; tool: Step['tool']; label: string; status: 'done' | 'skipped' | 'failed'; message?: string; auditId?: string; /** For the quantities step: what was saved. */ done?: { name: string; qty: number; previous: number | null }[] }
export interface RunResult { startedAt: string; finished: boolean; steps: StepResult[]; undo?: { startedAt: string; finished: boolean; steps: StepResult[] } }

type Data = Record<string, unknown>;
type Acted = { ok: true; data: Data; auditId?: string } | { ok: false; message: string };

async function act(who: ToolSession, tool: string, input: Data): Promise<Acted> {
  // loaded when needed: the registry contains the apply tool, which contains this file
  const { runTool, pendingActions } = await import('../index');
  const form = await pendingActions.create(who, { tool, origin: 'LAUNCHER' });
  if (!form.ok) return { ok: false, message: form.message };
  const r = await runTool(who, tool, input, { confirmation: form.data.id });
  return r.ok ? { ok: true, data: (r.data ?? {}) as Data, auditId: r.auditId } : { ok: false, message: r.message };
}
async function read(who: ToolSession, tool: string, input: Data = {}) {
  const { runTool } = await import('../index');
  return runTool(who, tool, input);
}

const blank = (v: unknown) => v === null || v === undefined || v === '';
const eq = (a: unknown, b: unknown) => (blank(a) && blank(b)) || (!blank(a) && !blank(b) && (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : String(a).trim().toLowerCase() === String(b).trim().toLowerCase()));
const done = (s: Step, auditId?: string, extra: Partial<StepResult> = {}): StepResult => ({ key: s.key, tool: s.tool, label: s.label, status: 'done', ...(auditId ? { auditId } : {}), ...extra });
const skipped = (s: Step, message: string): StepResult => ({ key: s.key, tool: s.tool, label: s.label, status: 'skipped', message });
const failed = (s: Step, message: string): StepResult => ({ key: s.key, tool: s.tool, label: s.label, status: 'failed', message });
const istToday = (now: Date) => new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);

const partOf = (customerName: string, partNumber: string) => db.part.findFirst({ where: { customer: { nameKey: partyNameKey(customerName) }, partKey: partNumberKey(partNumber) }, include: { customer: true, bomLines: { include: { material: { select: { name: true } } } } } });

async function runStep(who: ToolSession, s: Step, now: Date): Promise<StepResult> {
  const input = s.input;
  switch (s.tool) {
    case 'create_material': case 'create_party': case 'create_part': {
      const r = await act(who, s.tool, input);
      return r.ok ? done(s, r.auditId) : failed(s, r.message);
    }
    case 'update_material': {
      const m = await db.material.findUnique({ where: { id: String(input.materialId) } });
      if (!m) return skipped(s, 'It is not in the list any more.');
      for (const [k, was] of Object.entries(s.before ?? {})) if (!eq((m as unknown as Data)[k], was)) return skipped(s, `Its ${k} was changed by somebody since the plan was made, so I left it.`);
      const r = await act(who, s.tool, input);
      return r.ok ? done(s, r.auditId) : failed(s, r.message);
    }
    case 'update_party': {
      const p = await db.party.findUnique({ where: { id: String(input.partyId) } });
      if (!p) return skipped(s, 'It is not in the list any more.');
      for (const [k, was] of Object.entries(s.before ?? {})) if (k !== 'addRole' && !eq((p as unknown as Data)[k], was)) return skipped(s, `Its ${k} was changed by somebody since the plan was made, so I left it.`);
      const r = await act(who, s.tool, input);
      return r.ok ? done(s, r.auditId) : failed(s, r.message);
    }
    case 'update_part': {
      const p = await db.part.findUnique({ where: { id: String(input.partId) } });
      if (!p) return skipped(s, 'It is not in the list any more.');
      for (const [k, was] of Object.entries(s.before ?? {})) if (!eq((p as unknown as Data)[k], was)) return skipped(s, `Its ${k} was changed by somebody since the plan was made, so I left it.`);
      const r = await act(who, s.tool, input);
      return r.ok ? done(s, r.auditId) : failed(s, r.message);
    }
    case 'set_part_bom': {
      const part = await partOf(String(input.customerName), String(input.partNumber));
      if (!part) return failed(s, 'The part is not in the list (it may not have been added).');
      const was = ((s.before?.lines ?? []) as { materialName: string; qtyPerPiece: number }[]);
      const now_ = new Map(part.bomLines.map((b) => [materialNameKey(b.material.name), Number(b.qtyPerPiece)]));
      if (now_.size !== was.length || !was.every((l) => now_.get(materialNameKey(l.materialName)) === Number(l.qtyPerPiece))) return skipped(s, 'Its bill of materials was changed by somebody since the plan was made, so I left it.');
      const lines = input.lines as { materialName: string; qtyPerPiece: number }[];
      const mats = await db.material.findMany({ where: { nameKey: { in: lines.map((l) => materialNameKey(l.materialName)) }, isActive: true }, select: { id: true, nameKey: true } });
      const id = new Map(mats.map((m) => [m.nameKey, m.id]));
      const missing = lines.find((l) => !id.has(materialNameKey(l.materialName)));
      if (missing) return failed(s, `"${missing.materialName}" is not in the materials list (it may not have been added).`);
      const r = await act(who, 'set_part_bom', { partId: part.id, lines: lines.map((l) => ({ materialId: id.get(materialNameKey(l.materialName))!, qtyPerPiece: l.qtyPerPiece })) });
      return r.ok ? done(s, r.auditId) : failed(s, r.message);
    }
    case 'set_opening_quantities': return quantities(who, s, now);
  }
}

async function quantities(who: ToolSession, s: Step, now: Date): Promise<StepResult> {
  const items = (s.input.items as { name: string; qty: number; previous: number | null }[]);
  const opening = await db.stockCount.findFirst({ where: { isOpening: true }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, number: true } });
  if (opening?.status === 'APPROVED') return skipped(s, `The opening count (${opening.number}) is already approved, so quantities cannot be added to it.`);
  if (opening?.status === 'PENDING_APPROVAL') return skipped(s, `The opening count (${opening.number}) is waiting for your approval. Send it back first, then add the quantities.`);
  if (!opening) {
    const started = await act(who, 'start_stock_count', { countDate: istToday(now), isOpening: true });
    if (!started.ok) return failed(s, `Could not start the opening count: ${started.message}`);
  }
  const sheet = await read(who, 'list_count_lines', {});
  if (!sheet.ok) return failed(s, `Could not read the count sheet: ${sheet.message}`);
  const data = sheet.data as { count: { id: string }; rows: { id: string; material: string; countedQty: number | null }[] };
  const lineOf = new Map(data.rows.map((r) => [materialNameKey(r.material), r]));
  const todo: { id: string; item: (typeof items)[number] }[] = [];
  const left: string[] = [];
  for (const item of items) {
    const line = lineOf.get(materialNameKey(item.name));
    if (!line) { left.push(`${item.name}: not on the count sheet`); continue; }
    if (item.previous === null ? line.countedQty !== null && Number(line.countedQty) !== item.qty : Number(line.countedQty) !== item.previous) { left.push(`${item.name}: its count was changed since the plan was made`); continue; }
    todo.push({ id: line.id, item });
  }
  const saved: typeof items = [];
  for (let i = 0; i < todo.length; i += 200) {
    const batch = todo.slice(i, i + 200);
    const r = await act(who, 'save_count_sheet', { stockCountId: data.count.id, lines: batch.map((b) => ({ stockCountLineId: b.id, countedQty: b.item.qty })) });
    if (r.ok) { saved.push(...batch.map((b) => b.item)); continue; }
    // one bad line refuses its whole batch: try a line at a time, so only the bad one is left out
    for (const one of batch) {
      const x = await act(who, 'save_count_sheet', { stockCountId: data.count.id, lines: [{ stockCountLineId: one.id, countedQty: one.item.qty }] });
      if (x.ok) saved.push(one.item); else left.push(x.message);
    }
  }
  const message = `${saved.length} of ${items.length} quantities are on the count sheet${left.length ? `. Left out: ${left.slice(0, 5).join('; ')}${left.length > 5 ? ` and ${left.length - 5} more` : ''}` : ''}`;
  return { key: s.key, tool: s.tool, label: s.label, status: saved.length === 0 && items.length > 0 ? 'failed' : 'done', message, done: saved };
}

export async function executeSteps(who: ToolSession, steps: Step[], opts: { now?: Date; onProgress?: (done: StepResult[]) => Promise<void> } = {}): Promise<StepResult[]> {
  const now = opts.now ?? new Date();
  const out: StepResult[] = [];
  for (const s of steps) {
    let r: StepResult;
    try { r = await runStep(who, s, now); } catch (e) { console.error('[import] step failed:', e instanceof Error ? e.message : e); r = failed(s, "That one didn't go through."); }
    out.push(r);
    if (opts.onProgress && out.length % 25 === 0) await opts.onProgress(out);
  }
  return out;
}

// ── undo ────────────────────────────────────────────────────────────────────────────────────────────
const REASON = 'Undo of an import';

/**
 * Takes an applied import back, newest change first, one gateway call each. It only undoes what it can undo honestly: a change is
 * put back only if the thing still has the value the import gave it (somebody else's later change is never overwritten), a
 * material only if no stock has moved on it, and a blank that was filled cannot be made blank again (said, not hidden).
 */
export async function undoSteps(who: ToolSession, steps: Step[], results: StepResult[]): Promise<StepResult[]> {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const out: StepResult[] = [];
  for (const r of [...results].reverse()) {
    const s = byKey.get(r.key);
    if (!s || r.status !== 'done') continue;
    try { out.push(await undoOne(who, s, r)); } catch (e) { console.error('[import] undo failed:', e instanceof Error ? e.message : e); out.push(failed(s, "That one couldn't be undone.")); }
  }
  return out;
}

async function undoFields(who: ToolSession, s: Step, tool: string, idKey: string, current: Data): Promise<StepResult> {
  const restore: Data = {};
  const stuck: string[] = [];
  for (const [k, was] of Object.entries(s.before ?? {})) {
    if (k === 'addRole') { stuck.push('the extra role stays (a role can never be taken away)'); continue; }
    if (!eq(current[k], s.input[k])) { stuck.push(`${k} was changed by somebody after the import, so it stays`); continue; }
    if (blank(was)) { stuck.push(`${k} stays (it was blank before, and a filled box cannot be made blank again)`); continue; }
    restore[k] = was;
  }
  if (Object.keys(restore).length === 0) return skipped(s, stuck.join('; ') || 'Nothing to put back.');
  const r = await act(who, tool, { [idKey]: s.input[idKey], ...restore });
  if (!r.ok) return failed(s, r.message);
  return done(s, r.auditId, stuck.length ? { message: `Put back, except: ${stuck.join('; ')}` } : {});
}

async function undoOne(who: ToolSession, s: Step, r: StepResult): Promise<StepResult> {
  switch (s.tool) {
    case 'create_material': {
      const m = await db.material.findFirst({ where: { nameKey: materialNameKey(String(s.input.name)) } });
      if (!m || !m.isActive) return skipped(s, 'It is already gone.');
      const x = await act(who, 'deactivate_material', { materialId: m.id, reason: REASON });
      return x.ok ? done(s, x.auditId, { message: 'No longer in use (kept in the history)' }) : skipped(s, x.message);
    }
    case 'create_party': {
      const p = await db.party.findFirst({ where: { nameKey: partyNameKey(String(s.input.name)) } });
      if (!p || !p.isActive) return skipped(s, 'It is already gone.');
      const x = await act(who, 'deactivate_party', { partyId: p.id, reason: REASON });
      return x.ok ? done(s, x.auditId, { message: 'No longer in use (kept in the history)' }) : skipped(s, x.message);
    }
    case 'create_part': {
      const p = await partOf(String(s.input.customerName), String(s.input.partNumber));
      if (!p || !p.isActive) return skipped(s, 'It is already gone.');
      const x = await act(who, 'update_part', { partId: p.id, noLongerMade: true });
      return x.ok ? done(s, x.auditId, { message: 'Marked as no longer made (kept in the history)' }) : skipped(s, x.message);
    }
    case 'update_material': {
      const m = await db.material.findUnique({ where: { id: String(s.input.materialId) } });
      return m ? undoFields(who, s, 'update_material', 'materialId', m as unknown as Data) : skipped(s, 'It is not in the list any more.');
    }
    case 'update_party': {
      const p = await db.party.findUnique({ where: { id: String(s.input.partyId) } });
      return p ? undoFields(who, s, 'update_party', 'partyId', p as unknown as Data) : skipped(s, 'It is not in the list any more.');
    }
    case 'update_part': {
      const p = await db.part.findUnique({ where: { id: String(s.input.partId) } });
      return p ? undoFields(who, s, 'update_part', 'partId', p as unknown as Data) : skipped(s, 'It is not in the list any more.');
    }
    case 'set_part_bom': {
      const was = ((s.before?.lines ?? []) as { materialName: string; qtyPerPiece: number }[]);
      if (was.length === 0) return skipped(s, "A bill of materials can't be emptied. If the part was added by this import it is marked as no longer made.");
      const part = await partOf(String(s.input.customerName), String(s.input.partNumber));
      if (!part) return skipped(s, 'The part is not in the list any more.');
      const set = s.input.lines as { materialName: string; qtyPerPiece: number }[];
      const now_ = new Map(part.bomLines.map((b) => [materialNameKey(b.material.name), Number(b.qtyPerPiece)]));
      if (now_.size !== set.length || !set.every((l) => now_.get(materialNameKey(l.materialName)) === Number(l.qtyPerPiece))) return skipped(s, 'Its bill of materials was changed after the import, so it stays.');
      const mats = await db.material.findMany({ where: { nameKey: { in: was.map((l) => materialNameKey(l.materialName)) } }, select: { id: true, nameKey: true } });
      const id = new Map(mats.map((m) => [m.nameKey, m.id]));
      if (was.some((l) => !id.has(materialNameKey(l.materialName)))) return skipped(s, 'One of the old materials is not in the list any more.');
      const x = await act(who, 'set_part_bom', { partId: part.id, lines: was.map((l) => ({ materialId: id.get(materialNameKey(l.materialName))!, qtyPerPiece: l.qtyPerPiece })) });
      return x.ok ? done(s, x.auditId) : failed(s, x.message);
    }
    case 'set_opening_quantities': {
      const opening = await db.stockCount.findFirst({ where: { isOpening: true }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true } });
      if (!opening || (opening.status !== 'DRAFT' && opening.status !== 'REJECTED')) return skipped(s, 'The opening count has gone to you for approval, so its quantities stay. Send it back to change them.');
      const sheet = await read(who, 'list_count_lines', {});
      if (!sheet.ok) return failed(s, sheet.message);
      const lines = new Map((sheet.data as { rows: { id: string; material: string; countedQty: number | null }[] }).rows.map((l) => [materialNameKey(l.material), l]));
      const back: { stockCountLineId: string; countedQty: number }[] = [];
      let kept = 0, zeroed = 0;
      for (const it of r.done ?? []) {
        const line = lines.get(materialNameKey(it.name));
        if (!line || Number(line.countedQty) !== it.qty) { kept++; continue; }
        // a line that has been filled cannot be left blank again: a material the import added goes back to 0
        if (it.previous === null) zeroed++;
        back.push({ stockCountLineId: line.id, countedQty: it.previous ?? 0 });
      }
      for (let i = 0; i < back.length; i += 200) {
        const x = await act(who, 'save_count_sheet', { stockCountId: opening.id, lines: back.slice(i, i + 200) });
        if (!x.ok) return failed(s, x.message);
      }
      return done(s, undefined, { message: `${back.length} quantities put back${zeroed ? ` (${zeroed} that the import filled in are now 0, because a filled line cannot be left blank)` : ''}${kept ? `; ${kept} were changed since, so they stay` : ''}` });
    }
  }
}
