import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { groupIndian, inr, qty, UOM_LONG } from '@/lib/format';
import { ToolError } from '../errors';
import { defineTool } from './define';
import { flag, opt } from './helpers';
import { jobTotals } from './jobcost';
import { findJob, jobLabel } from './jobs';
import { notify, ownerIds } from './notifications';
import type { Db } from './types';

// ── words and small helpers ────────────────────────────────────────────────────────────────────────
/** Pieces and sets are handled whole. */
const WHOLE_UNITS = new Set(['NOS', 'SET']);
/** A job that used more than this much over its BOM is said aloud when it closes, and the owner is told. */
export const OVER_BOM = 0.05;
/** Marks an issue as extra material beyond the BOM (rework), so the variance report shows it as such. */
export const TOP_UP = 'TOP_UP';
const STATUS_TEXT: Record<string, string> = { OPEN: 'open', MATERIAL_ISSUED: 'material issued', IN_PRODUCTION: 'in production', COMPLETED: 'completed', CLOSED: 'closed', CANCELLED: 'cancelled' };

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const numeric = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/,/g, '')) : v === '' || v === null ? undefined : v);
const jobRef = z.string({ required_error: 'Which job?' }).min(1, 'Which job?').max(64);
const amount = (what: string) => z.preprocess(numeric, z.number({ required_error: `How much ${what}?`, invalid_type_error: 'Type the quantity as a number.' }).gt(0, 'The quantity must be more than zero.').max(1e9, 'That quantity is too big.'));
const who = (a: { actorType: 'HUMAN' | 'AGENT'; actorId: string; agentRunId?: string; toolName: string }) => ({ actorType: a.actorType, actorId: a.actorId, agentRunId: a.agentRunId, toolName: a.toolName });

/** Standing material that fell below its minimum with this movement, and any material now below zero. */
export async function watch(db: Db, materialIds: string[], before: Map<string, number>) {
  const mats = await db.material.findMany({ where: { id: { in: materialIds } }, include: { balance: true } });
  const negatives: { materialId: string; material: string; unit: string; balance: number }[] = [];
  const belowMin: { materialId: string; material: string; unit: string; balance: number; minimum: number; shortfall: number }[] = [];
  for (const m of mats) {
    const after = Number(m.balance?.quantity ?? 0);
    if (after < 0) negatives.push({ materialId: m.id, material: m.name, unit: m.uom, balance: after });
    const min = m.minimumLevel === null ? null : Number(m.minimumLevel);
    if (m.stockType === 'STANDING' && min !== null && after < min && (before.get(m.id) ?? 0) >= min) {
      belowMin.push({ materialId: m.id, material: m.name, unit: m.uom, balance: after, minimum: min, shortfall: round4(min - after) });
    }
  }
  return { negatives, belowMin };
}

/** The owner hears about a negative balance; the owner and the storekeepers hear about a standing material that fell below its minimum. */
export async function tell(db: Db, w: Awaited<ReturnType<typeof watch>>, actorId: string) {
  if (w.negatives.length) {
    await notify(db, await ownerIds(db), {
      type: 'NEGATIVE_STOCK_WARNING', title: 'Stock went below zero', body: `${w.negatives.map((n) => `${n.material} is now ${qty(n.balance, n.unit)}`).join('; ')}. The paperwork is probably behind the floor.`,
    }, actorId);
  }
  if (w.belowMin.length) {
    const keepers = (await db.user.findMany({ where: { role: 'STOREKEEPER', isActive: true }, select: { id: true } })).map((u) => u.id);
    await notify(db, [...(await ownerIds(db)), ...keepers], {
      type: 'MIN_LEVEL_BREACH', title: 'Below the minimum', body: `${w.belowMin.map((b) => `${b.material}: ${qty(b.balance, b.unit)} left, minimum ${qty(b.minimum, b.unit)}`).join('; ')}.`,
    }, actorId);
  }
}

export const followFacts = (negatives: { material: string; unit: string; balance: number }[], belowMin: { material: string; unit: string; balance: number; minimum: number }[]) => [
  ...negatives.map((n) => `${n.material} is now at ${qty(n.balance, n.unit)}, below zero: the paperwork is behind the floor. The owner has been told.`),
  ...belowMin.map((b) => `${b.material} is now ${qty(b.balance, b.unit)}, below its minimum of ${qty(b.minimum, b.unit)}. The owner and the storekeeper have been told.`),
];
const poChips = (belowMin: { materialId: string; material: string; shortfall: number }[]) =>
  belowMin.slice(0, 2).map((b) => ({ label: `Raise a PO for ${b.material}`, form: 'create_purchase_order', prefill: { lines: [{ materialId: b.materialId, quantity: b.shortfall }] } }));

// ── issue_material ─────────────────────────────────────────────────────────────────────────────────
const issueLine = z.object({ materialId: z.string({ required_error: 'Choose the material.' }).min(1, 'Choose the material.').max(64), quantity: amount('to give out'), topUp: flag.optional() });

interface PlanLine { materialId: string; material: string; unit: string; quantity: number; topUp: boolean; inStock: number }

/** What an issue would give out: the whole outstanding BOM, or the lines asked for. Throws in plain words when it cannot. */
async function planIssue(db: Db, jobId: string, lines?: { materialId: string; quantity: number; topUp?: boolean }[]) {
  const job = await findJob(db, jobId);
  if (['CANCELLED', 'CLOSED', 'COMPLETED'].includes(job.status)) {
    throw new ToolError('JOB_NOT_ISSUABLE', `${job.number} is ${STATUS_TEXT[job.status]}, so nothing more can be given out to it.`, undefined, 'jobId');
  }
  const bom = await db.jobBomLine.findMany({ where: { jobId: job.id }, include: { material: { include: { balance: true } } }, orderBy: { material: { name: 'asc' } } });
  const plan: PlanLine[] = [];
  if (!lines?.length) {
    for (const l of bom) {
      const left = round4(Number(l.requiredQty) - Number(l.issuedQty));
      if (left > 0) plan.push({ materialId: l.materialId, material: l.material.name, unit: l.material.uom, quantity: left, topUp: false, inStock: Number(l.material.balance?.quantity ?? 0) });
    }
    if (bom.length === 0) throw new ToolError('NO_BOM', `${job.number} has no bill of materials yet, so there is nothing to give out. Add the BOM first, or say which material and how much.`, undefined, 'jobId');
    if (plan.length === 0) throw new ToolError('NOTHING_TO_ISSUE', `Everything the bill of materials needs has already been given out to ${job.number}. If it needs more (rework), give the extra as a top-up.`, undefined, 'jobId');
    return { job, plan };
  }
  const seen = new Set<string>();
  const mats = await db.material.findMany({ where: { id: { in: lines.map((l) => l.materialId) } }, include: { balance: true } });
  const byId = new Map(mats.map((m) => [m.id, m]));
  for (const l of lines) {
    const m = byId.get(l.materialId);
    if (!m || !m.isActive) throw new ToolError('NOT_FOUND', "One of those materials couldn't be found.", undefined, 'lines');
    if (seen.has(m.id)) throw new ToolError('DUPLICATE_LINE', `${m.name} is on the list twice. Put it on one line.`, undefined, 'lines');
    seen.add(m.id);
    if (WHOLE_UNITS.has(m.uom) && !Number.isInteger(l.quantity)) throw new ToolError('INVALID_QUANTITY', `${m.name} is given out in whole ${UOM_LONG[m.uom] ?? 'units'}.`, undefined, 'lines');
    const b = bom.find((x) => x.materialId === m.id);
    const topUp = l.topUp === true;
    if (!b && !topUp) throw new ToolError('NOT_ON_BOM', `${m.name} isn't on the bill of materials of ${job.number}. If it is extra material (rework), tick "extra, for rework".`, undefined, 'lines');
    if (b && !topUp) {
      const left = round4(Number(b.requiredQty) - Number(b.issuedQty));
      if (l.quantity > left + 1e-9) {
        throw new ToolError('OVER_BOM', left > 0
          ? `${m.name}: the BOM needs ${qty(left, m.uom)} more, not ${qty(l.quantity, m.uom)}. If the extra is for rework, tick "extra, for rework".`
          : `${m.name}: everything the BOM needs has been given out already. If more is needed (rework), tick "extra, for rework".`, undefined, 'lines');
      }
    }
    plan.push({ materialId: m.id, material: m.name, unit: m.uom, quantity: l.quantity, topUp, inStock: Number(m.balance?.quantity ?? 0) });
  }
  return { job, plan };
}

export const issueMaterial = defineTool({
  name: 'issue_material', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ jobId: jobRef, lines: z.array(issueLine).max(60, 'That is a lot of lines.').optional() }),
  form: {
    title: 'Give out material to a job', verb: 'Give out material',
    intro: 'Leave the list empty to give out everything the BOM still needs. Add lines only for part of it, or for extra material (rework).',
    fields: [
      { name: 'jobId', label: 'Job', type: 'job', pickerFilter: 'issuable', required: true },
      { name: 'lines', label: 'Only these (optional)', type: 'issueLines' },
    ],
  },
  stamp: 'MATERIAL GIVEN OUT',
  describe: (a) => [
    `${a.number} · ${a.customer}`,
    ...((a.lines as { material: string; unit: string; quantity: number; topUp: boolean }[]) ?? []).map((l) => `${l.material}: ${qty(l.quantity, l.unit)}${l.topUp ? ' (extra, for rework)' : ''}`),
    ...((a.negatives as { material: string; unit: string; balance: number }[]) ?? []).map((n) => `${n.material} is now ${qty(n.balance, n.unit)}, below zero. The owner is told.`),
    ...((a.belowMin as { material: string; unit: string; balance: number; minimum: number }[]) ?? []).map((b) => `${b.material} is now below its minimum (${qty(b.balance, b.unit)} of ${qty(b.minimum, b.unit)}).`),
  ],
  preview: async (ctx, input) => {
    if (typeof input.jobId !== 'string' || !input.jobId) return { info: ['Which job is the material for?'] };
    try {
      const { job, plan } = await planIssue(ctx.db, input.jobId, Array.isArray(input.lines) ? (input.lines as { materialId: string; quantity: number; topUp?: boolean }[]) : undefined);
      const info = [`${jobLabel(job)}`, Array.isArray(input.lines) && input.lines.length ? 'This will be given out:' : 'Everything the BOM still needs will be given out:'];
      for (const p of plan) info.push(`${p.material}: ${qty(p.quantity, p.unit)}${p.topUp ? ' (extra, for rework)' : ''}${p.inStock < p.quantity ? ` · in stock ${qty(p.inStock, p.unit)}: it will go below zero` : ''}`);
      return { info, values: { jobId: job.id } };
    } catch (e) { return { info: [e instanceof ToolError ? e.message : 'Choose the job.'] }; }
  },
  handler: async (ctx, input) => {
    const { job, plan } = await planIssue(ctx.db, input.jobId, input.lines);
    const before = new Map(plan.map((p) => [p.materialId, p.inStock]));
    const bom = await ctx.db.jobBomLine.findMany({ where: { jobId: job.id } });
    for (const p of plan) {
      await ctx.db.stockMovement.create({
        data: { materialId: p.materialId, type: 'ISSUE', direction: 'OUT', quantity: p.quantity, rate: 0, jobId: job.id, movementDate: ctx.now, reasonCode: p.topUp ? TOP_UP : null, notes: p.topUp ? 'Extra material for rework' : null, ...who(ctx.actor) },
      });
      const b = bom.find((x) => x.materialId === p.materialId);
      if (b) await ctx.db.jobBomLine.update({ where: { id: b.id }, data: { issuedQty: { increment: p.quantity } } });
    }
    if (job.status === 'OPEN') await ctx.db.job.update({ where: { id: job.id }, data: { status: 'MATERIAL_ISSUED' } });
    const w = await watch(ctx.db, plan.map((p) => p.materialId), before);
    await tell(ctx.db, w, ctx.session.userId);
    const after = await ctx.db.stockBalance.findMany({ where: { materialId: { in: plan.map((p) => p.materialId) } }, select: { materialId: true, quantity: true } });
    const bal = new Map(after.map((a) => [a.materialId, Number(a.quantity)]));
    const lines = plan.map((p) => ({ material: p.material, unit: p.unit, quantity: p.quantity, topUp: p.topUp, balanceAfter: bal.get(p.materialId) ?? 0 }));
    return {
      data: { jobId: job.id, number: job.number, customer: job.customer.name, lines, negatives: w.negatives, belowMin: w.belowMin },
      audit: { entityType: 'Job', entityId: job.id, action: 'ISSUE', before: { status: job.status }, after: { number: job.number, customer: job.customer.name, lines, negatives: w.negatives, belowMin: w.belowMin, status: 'MATERIAL_ISSUED' } },
    };
  },
  followUps: async (_ctx, _input, result) => {
    const r = result as { negatives: { material: string; unit: string; balance: number }[]; belowMin: { materialId: string; material: string; unit: string; balance: number; minimum: number; shortfall: number }[] };
    return { facts: followFacts(r.negatives, r.belowMin), chips: poChips(r.belowMin) };
  },
});

// ── return_material ────────────────────────────────────────────────────────────────────────────────
const returnLine = z.object({ materialId: z.string({ required_error: 'Choose the material.' }).min(1, 'Choose the material.').max(64), quantity: amount('came back') });

async function heldBy(db: Db, jobId: string) {
  const t = await jobTotals(db, jobId);
  return t;
}

export const returnMaterial = defineTool({
  name: 'return_material', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ jobId: jobRef, lines: z.array(returnLine, { required_error: 'Add what came back.' }).min(1, 'Add what came back.').max(60, 'That is a lot of lines.'), note: opt(300) }),
  form: {
    title: 'Material back from a job', verb: 'Take back into stock', intro: 'It goes back at the current average rate. You never type a rate.',
    fields: [
      { name: 'jobId', label: 'Job', type: 'job', pickerFilter: 'returnable', required: true },
      { name: 'lines', label: 'What came back', type: 'returnLines', required: true },
      { name: 'note', label: 'Note', type: 'text' },
    ],
  },
  stamp: 'MATERIAL TAKEN BACK',
  describe: (a) => [
    `${a.number} · ${a.customer}`,
    ...((a.lines as { material: string; unit: string; quantity: number }[]) ?? []).map((l) => `${l.material}: ${qty(l.quantity, l.unit)} back in stock`),
    'Next: close the job when everything is back.',
  ],
  preview: async (ctx, input) => {
    if (typeof input.jobId !== 'string' || !input.jobId) return { info: ['Which job did it come from?'] };
    try {
      const job = await findJob(ctx.db, input.jobId);
      const held = await heldBy(ctx.db, job.id);
      const mats = await ctx.db.material.findMany({ where: { id: { in: [...held.keys()] } }, select: { id: true, name: true, uom: true } });
      const info = [jobLabel(job)];
      if (job.status === 'CLOSED') info.push('This job is closed: its cost is fixed, so nothing can be returned to it.');
      const out = mats.filter((m) => (held.get(m.id)?.net ?? 0) > 0).map((m) => `${m.name}: ${qty(held.get(m.id)?.net ?? 0, m.uom)} out with the job`);
      info.push(out.length ? 'Still out with the job:' : 'Nothing is out with this job.', ...out);
      return { info, values: { jobId: job.id } };
    } catch (e) { return { info: [e instanceof ToolError ? e.message : 'Choose the job.'] }; }
  },
  handler: async (ctx, input) => {
    const job = await findJob(ctx.db, input.jobId);
    if (job.status === 'CLOSED') throw new ToolError('JOB_CLOSED', `${job.number} is closed and its cost is fixed, so nothing can be returned to it. If something was left out, the owner can reverse the issue.`, undefined, 'jobId');
    if (job.status === 'CANCELLED') throw new ToolError('JOB_NOT_OPEN', `${job.number} was cancelled.`, undefined, 'jobId');
    const held = await heldBy(ctx.db, job.id);
    const mats = await ctx.db.material.findMany({ where: { id: { in: input.lines.map((l) => l.materialId) } } });
    const byId = new Map(mats.map((m) => [m.id, m]));
    const seen = new Set<string>();
    const prepared = input.lines.map((l) => {
      const m = byId.get(l.materialId);
      if (!m) throw new ToolError('NOT_FOUND', "One of those materials couldn't be found.", undefined, 'lines');
      if (seen.has(m.id)) throw new ToolError('DUPLICATE_LINE', `${m.name} is on the list twice. Put it on one line.`, undefined, 'lines');
      seen.add(m.id);
      if (WHOLE_UNITS.has(m.uom) && !Number.isInteger(l.quantity)) throw new ToolError('INVALID_QUANTITY', `${m.name} comes back in whole ${UOM_LONG[m.uom] ?? 'units'}.`, undefined, 'lines');
      const out = held.get(m.id)?.net ?? 0;
      if ((held.get(m.id)?.issued ?? 0) === 0) throw new ToolError('NOT_ISSUED_TO_JOB', `${m.name} was never given out to ${job.number}, so it can't come back from it.`, undefined, 'lines');
      if (out <= 0) throw new ToolError('RETURN_EXCEEDS_ISSUE', `Nothing of ${m.name} is out with ${job.number} any more: it has all come back.`, undefined, 'lines');
      if (l.quantity > out + 1e-9) throw new ToolError('RETURN_EXCEEDS_ISSUE', `Only ${qty(out, m.uom)} of ${m.name} is out with ${job.number}, not ${qty(l.quantity, m.uom)}.`, undefined, 'lines');
      return { m, quantity: l.quantity };
    });
    const bom = await ctx.db.jobBomLine.findMany({ where: { jobId: job.id } });
    for (const p of prepared) {
      await ctx.db.stockMovement.create({ data: { materialId: p.m.id, type: 'RETURN', direction: 'IN', quantity: p.quantity, rate: 0, jobId: job.id, movementDate: ctx.now, notes: input.note, ...who(ctx.actor) } });
      const b = bom.find((x) => x.materialId === p.m.id);
      if (b) await ctx.db.jobBomLine.update({ where: { id: b.id }, data: { returnedQty: { increment: p.quantity } } });
    }
    const lines = prepared.map((p) => ({ material: p.m.name, unit: p.m.uom, quantity: p.quantity }));
    return {
      data: { jobId: job.id, number: job.number, customer: job.customer.name, lines },
      audit: { entityType: 'Job', entityId: job.id, action: 'RETURN', reason: input.note, after: { number: job.number, customer: job.customer.name, lines } },
    };
  },
  followUps: async (_ctx, _input, result) => ({ facts: [], chips: [{ label: `Close ${(result as { number: string }).number}`, form: 'close_job', prefill: { jobId: (result as { jobId: string }).jobId } }] }),
});

// ── close_job ──────────────────────────────────────────────────────────────────────────────────────
export const closeJob = defineTool({
  name: 'close_job', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ jobId: jobRef, nothingReturned: flag.optional() }),
  form: {
    title: 'Close a job', verb: 'Close job', intro: "Closing fixes the job's material cost (given out less taken back). Did any material come back? Record that first.",
    fields: [
      { name: 'jobId', label: 'Job', type: 'job', pickerFilter: 'closable', required: true },
      { name: 'nothingReturned', label: 'Nothing came back', type: 'checkbox', hint: 'Tick this only if none of the material came back to the store.' },
    ],
  },
  stamp: 'JOB CLOSED',
  describe: (a) => [
    `${a.number} · ${a.customer} · ${groupIndian(Number(a.quantity))} pieces`,
    ...(a.showCost
      ? [`Material cost ${inr(Number(a.materialCost))}`, `Cost per piece ${inr(Number(a.costPerPiece))}${a.sample ? ' (a sample: its cost stays with the company)' : ''}`]
      : ['The job is closed. Its cost is in the owner\'s report.']),
    ...((a.overBom as { material: string; unit: string; planned: number; used: number; overPct: number }[]) ?? []).map((o) => `${o.material}: used ${qty(o.used, o.unit)} against ${qty(o.planned, o.unit)} planned (${o.overPct}% over)`),
  ],
  preview: async (ctx, input) => {
    if (typeof input.jobId !== 'string' || !input.jobId) return { info: ['Which job is finished?'] };
    try {
      const job = await findJob(ctx.db, input.jobId);
      const t = await jobTotals(ctx.db, job.id);
      const mats = await ctx.db.material.findMany({ where: { id: { in: [...t.keys()] } }, select: { id: true, name: true, uom: true } });
      const info = [jobLabel(job)];
      const issued = [...t.values()].reduce((s, x) => s + x.issued, 0);
      const returned = [...t.values()].reduce((s, x) => s + x.returned, 0);
      if (issued === 0) info.push('Nothing has been given out to this job.');
      for (const m of mats) { const x = t.get(m.id); if (x) info.push(`${m.name}: ${qty(x.issued, m.uom)} given out${x.returned ? `, ${qty(x.returned, m.uom)} back` : ''}`); }
      if (issued > 0 && returned === 0) info.push('Nothing has come back yet. If something did, record the return first.');
      return { info, values: { jobId: job.id } };
    } catch (e) { return { info: [e instanceof ToolError ? e.message : 'Choose the job.'] }; }
  },
  handler: async (ctx, input) => {
    const job = await findJob(ctx.db, input.jobId);
    if (job.status === 'CLOSED') throw new ToolError('JOB_ALREADY_CLOSED', `${job.number} is already closed.`, undefined, 'jobId');
    if (job.status === 'CANCELLED') throw new ToolError('JOB_NOT_OPEN', `${job.number} was cancelled.`, undefined, 'jobId');
    const t = await jobTotals(ctx.db, job.id);
    const issued = [...t.values()].reduce((s, x) => s + x.issued, 0);
    const returned = [...t.values()].reduce((s, x) => s + x.returned, 0);
    if (issued === 0) throw new ToolError('JOB_NOTHING_ISSUED', `Nothing has been given out to ${job.number}, so there is nothing to close. If it will not be made, cancel it instead.`, undefined, 'jobId');
    if (returned === 0 && !input.nothingReturned) {
      throw new ToolError('RETURN_ANSWER_REQUIRED', 'Did any material come back? If it did, record the return first. If nothing came back, tick "Nothing came back".', undefined, 'nothingReturned');
    }
    const cost = round2([...t.values()].reduce((s, x) => s + x.value, 0));
    const perPiece = round2(cost / job.quantity);
    await ctx.db.job.update({ where: { id: job.id }, data: { status: 'CLOSED', closedAt: ctx.now, materialCost: new Prisma.Decimal(cost) } });

    const bom = await ctx.db.jobBomLine.findMany({ where: { jobId: job.id }, include: { material: { select: { name: true, uom: true } } } });
    const overBom = bom.map((l) => {
      const used = round4(t.get(l.materialId)?.net ?? 0);
      const planned = Number(l.requiredQty);
      return { material: l.material.name, unit: l.material.uom, planned, used, overPct: Math.round(((used - planned) / planned) * 1000) / 10 };
    }).filter((o) => o.overPct > OVER_BOM * 100);
    if (overBom.length) {
      await notify(ctx.db, await ownerIds(ctx.db), {
        type: 'JOB_VARIANCE', title: 'A job used more than planned', body: `${job.number}: ${overBom.map((o) => `${o.material} ${qty(o.used, o.unit)} against ${qty(o.planned, o.unit)} (${o.overPct}% over)`).join('; ')}.`, entityType: 'Job', entityId: job.id,
      }, ctx.session.userId);
    }
    const isOwner = ctx.session.role === 'OWNER';
    return {
      data: { jobId: job.id, number: job.number, customer: job.customer.name, quantity: job.quantity, sample: job.type === 'SAMPLE', overBom, ...(isOwner ? { materialCost: cost, costPerPiece: perPiece } : {}) },
      audit: {
        entityType: 'Job', entityId: job.id, action: 'CLOSE', before: { status: job.status },
        after: { number: job.number, customer: job.customer.name, quantity: job.quantity, sample: job.type === 'SAMPLE', materialCost: cost, costPerPiece: perPiece, showCost: isOwner, overBom, nothingReturned: returned === 0 },
      },
    };
  },
  followUps: async (_ctx, _input, result) => {
    const r = result as { number: string; materialCost?: number; costPerPiece?: number; overBom: { material: string; unit: string; planned: number; used: number; overPct: number }[] };
    const facts = r.materialCost !== undefined ? [`${r.number} is closed. Material cost ${inr(r.materialCost)}, ${inr(r.costPerPiece ?? 0)} per piece.`] : [`${r.number} is closed. Its cost is in the owner's report.`];
    for (const o of r.overBom) facts.push(`${o.material} used ${o.overPct}% more than the BOM (${qty(o.used, o.unit)} against ${qty(o.planned, o.unit)}). The owner has been told.`);
    return { facts, chips: [] };
  },
});

