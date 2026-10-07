import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { dateText, groupIndian, inr, qty, timeText } from '@/lib/format';
import { materialNameKey } from '@/lib/names';
import { search } from '@/lib/similar';
import { ToolError } from '../errors';
import { REASON_TEXT } from './counts';
import { dateIn, istDate } from './corrections';
import { defineTool } from './define';
import { jobCost, jobTotals } from './jobcost';
import type { Db } from './types';

const MAX_ROWS = 50;
const MAX_IN_CHAT = 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const emptyToUndef = (v: unknown) => (v === '' || v === null ? undefined : v);
const idOpt = z.preprocess(emptyToUndef, z.string().min(1).max(64).optional());
const names = z.array(z.string().max(100)).max(20).optional();
const flag = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
const endOfDay = (ymd: string) => new Date(istDate(ymd).getTime() + 86_399_000);
const range = (from?: string, to?: string) => (from || to ? { ...(from ? { gte: istDate(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) } : undefined);
const reasonText = (r: string | null) => (r ? REASON_TEXT[r as keyof typeof REASON_TEXT] ?? r : null);
const signed = (n: number, uom: string) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${qty(Math.abs(n), uom)}`;

/** Materials by id or by the words people use; what could not be found is said, not guessed. */
async function resolveMaterials(db: Db, ids: (string | undefined)[], words: string[] | undefined) {
  const wanted = new Set<string>(ids.filter((x): x is string => !!x));
  const notFound: string[] = [];
  if (words?.length) {
    const all = await db.material.findMany({ select: { id: true, name: true, nameKey: true } });
    for (const w of words) {
      const exact = all.find((m) => m.nameKey === materialNameKey(w));
      const hits = exact ? [exact] : search(w, all, (m) => m.nameKey, (m) => m.name).slice(0, 3);
      if (!hits.length) notFound.push(w);
      for (const h of hits) wanted.add(h.id);
    }
  }
  return { ids: [...wanted], notFound, asked: wanted.size > 0 || notFound.length > 0 };
}

const notFoundNote = (nf: string[]) => `Couldn't find: ${nf.join(', ')}. Check the spelling.`;

// ── get_leak_report ────────────────────────────────────────────────────────────────────────────────
/**
 * Across all approved normal counts (never the opening count): per material, how often it was counted and how often it
 * differed, what is short, what that is worth at the current average, and how many differences nobody could explain.
 * Same arithmetic as the database view v_material_leak, with an optional period.
 */
export const getLeakReport = defineTool({
  name: 'get_leak_report', kind: 'read', roles: ['OWNER'],
  input: z.object({ from: dateIn, to: dateIn, materialNames: names }),
  handler: async (ctx, input) => {
    const found = await resolveMaterials(ctx.db, [], input.materialNames);
    const where: Prisma.StockCountLineWhereInput = {
      countedQty: { not: null }, differenceQty: { not: null },
      stockCount: { status: 'APPROVED', isOpening: false, ...(range(input.from, input.to) ? { countDate: range(input.from, input.to) } : {}) },
      ...(found.asked ? { materialId: { in: found.ids } } : {}),
    };
    const lines = await ctx.db.stockCountLine.findMany({ where, include: { material: { select: { name: true, uom: true } }, stockCount: { select: { countDate: true } } } });
    const rates = new Map((await ctx.db.stockBalance.findMany({ where: { materialId: { in: [...new Set(lines.map((l) => l.materialId))] } }, select: { materialId: true, averageRate: true } })).map((b) => [b.materialId, Number(b.averageRate)]));
    type Row = { materialId: string; material: string; unit: string; timesCounted: number; timesMismatched: number; netDifference: number; totalShortage: number; varianceValue: number; unexplainedCount: number; lastCounted: string; reasons: Map<string, number> };
    const by = new Map<string, Row>();
    for (const l of lines) {
      const r = by.get(l.materialId) ?? { materialId: l.materialId, material: l.material.name, unit: l.material.uom, timesCounted: 0, timesMismatched: 0, netDifference: 0, totalShortage: 0, varianceValue: 0, unexplainedCount: 0, lastCounted: '', reasons: new Map() };
      const d = Number(l.differenceQty);
      r.timesCounted += 1;
      if (d !== 0) {
        r.timesMismatched += 1;
        r.varianceValue += Math.abs(d) * (rates.get(l.materialId) ?? 0);
        const reason = l.reasonCode && l.reasonCode !== 'UNEXPLAINED' ? l.reasonCode : null;
        if (!reason) r.unexplainedCount += 1;
        const key = reasonText(reason ?? 'UNEXPLAINED') as string;
        r.reasons.set(key, (r.reasons.get(key) ?? 0) + 1);
      }
      r.netDifference += d;
      if (d < 0) r.totalShortage += Math.abs(d);
      const day = l.stockCount.countDate.toISOString();
      if (day > r.lastCounted) r.lastCounted = day;
      by.set(l.materialId, r);
    }
    const rows = [...by.values()].map((r) => ({
      materialId: r.materialId, material: r.material, unit: r.unit, timesCounted: r.timesCounted, timesMismatched: r.timesMismatched, netDifference: round4(r.netDifference),
      totalShortage: round4(r.totalShortage), varianceValue: round2(r.varianceValue), unexplainedCount: r.unexplainedCount, lastCounted: r.lastCounted,
      reasons: [...r.reasons.entries()].map(([k, n]) => `${k} ×${n}`).join(', '),
    })).filter((r) => r.timesMismatched > 0 || found.asked)
      .sort((a, b) => b.varianceValue - a.varianceValue || b.timesMismatched - a.timesMismatched || a.material.localeCompare(b.material));
    const counts = await ctx.db.stockCount.count({ where: { status: 'APPROVED', isOpening: false, ...(range(input.from, input.to) ? { countDate: range(input.from, input.to) } : {}) } });
    return {
      rows: rows.slice(0, MAX_ROWS), more: rows.length > MAX_ROWS, notFound: found.notFound, counts,
      totals: { materials: rows.length, mismatches: rows.reduce((s, r) => s + r.timesMismatched, 0), unexplained: rows.reduce((s, r) => s + r.unexplainedCount, 0), varianceValue: round2(rows.reduce((s, r) => s + r.varianceValue, 0)) },
      period: { from: input.from ?? null, to: input.to ?? null },
    };
  },
  view: (d) => [{
    kind: 'table',
    title: d.rows.length ? `Count differences: ${inr(d.totals.varianceValue)} in all, ${d.totals.unexplained} not explained` : undefined,
    columns: [{ key: 'm', label: 'Material' }, { key: 'c', label: 'Differed', align: 'right' }, { key: 's', label: 'Short by', align: 'right' }, { key: 'v', label: 'Worth', align: 'right' }, { key: 'u', label: 'Not explained', align: 'right' }],
    rows: d.rows.slice(0, MAX_IN_CHAT).map((r) => ({ m: r.material, c: `${r.timesMismatched} of ${r.timesCounted}`, s: r.totalShortage ? qty(r.totalShortage, r.unit) : '–', v: inr(r.varianceValue), u: String(r.unexplainedCount) })),
    note: d.notFound.length ? notFoundNote(d.notFound)
      : d.rows.length === 0 ? (d.counts === 0 ? 'No monthly count has been approved yet, so there is nothing to report. The opening count is never part of this.' : `${d.counts} monthly count${d.counts === 1 ? '' : 's'} approved, and every material matched.`)
      : d.rows.length > MAX_IN_CHAT || d.more ? `Showing ${MAX_IN_CHAT} of ${d.more ? `more than ${MAX_ROWS}` : d.rows.length}, biggest first. Worth is at today's average rate.` : "Worth is at today's average rate.",
  }],
});

// ── get_count_history ──────────────────────────────────────────────────────────────────────────────
/** Every count of a material, never overwritten: what the system said, what was counted, the reason, and who. */
export const getCountHistory = defineTool({
  name: 'get_count_history', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ materialId: idOpt, materialNames: names }),
  handler: async (ctx, input) => {
    const found = await resolveMaterials(ctx.db, [input.materialId], input.materialNames);
    if (!found.asked) throw new ToolError('MATERIAL_REQUIRED', 'Which material? Name one, like bobbins.', undefined, 'materialNames');
    const lines = await ctx.db.stockCountLine.findMany({
      where: { materialId: { in: found.ids }, countedQty: { not: null } },
      include: { material: { select: { name: true, uom: true } }, stockCount: { include: { countedBy: { select: { name: true } } } } },
      orderBy: [{ stockCount: { countDate: 'desc' } }, { stockCount: { createdAt: 'desc' } }], take: MAX_ROWS + 1,
    });
    const shown = lines.slice(0, MAX_ROWS);
    const countIds = [...new Set(shown.map((l) => l.stockCountId))];
    const events = await ctx.db.auditEvent.findMany({
      where: { OR: [{ entityType: 'StockCountLine', entityId: { in: shown.map((l) => l.id) } }, { entityType: 'StockCount', entityId: { in: countIds }, toolName: 'save_count_sheet' }] },
      include: { actor: { select: { name: true } } }, orderBy: { createdAt: 'desc' },
    });
    const who = (l: (typeof shown)[number]) => {
      const own = events.find((e) => e.entityType === 'StockCountLine' && e.entityId === l.id);
      if (own?.actor) return own.actor.name;
      const sheet = events.find((e) => e.entityType === 'StockCount' && e.entityId === l.stockCountId && ((e.afterJson as { materials?: string[] } | null)?.materials ?? []).includes(l.material.name));
      return sheet?.actor?.name ?? l.stockCount.countedBy?.name ?? null;
    };
    const STATUS: Record<string, string> = { DRAFT: 'Being counted', PENDING_APPROVAL: 'With the owner', REJECTED: 'Sent back', APPROVED: 'Approved' };
    return {
      rows: shown.map((l) => ({
        count: l.stockCount.number, date: l.stockCount.countDate.toISOString(), kind: l.stockCount.isOpening ? 'Opening count' : 'Monthly count', status: l.stockCount.status, statusText: STATUS[l.stockCount.status] ?? l.stockCount.status,
        material: l.material.name, unit: l.material.uom, systemQty: Number(l.systemQty), countedQty: Number(l.countedQty),
        difference: l.stockCount.isOpening ? null : l.differenceQty === null ? null : Number(l.differenceQty), reason: reasonText(l.reasonCode), by: who(l), note: l.notes,
      })),
      more: lines.length > MAX_ROWS, notFound: found.notFound,
    };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'd', label: 'Date' }, { key: 'c', label: 'Count' }, { key: 'sy', label: 'System', align: 'right' }, { key: 'co', label: 'Counted', align: 'right' }, { key: 'df', label: 'Difference', align: 'right' }, { key: 'r', label: 'Reason' }, { key: 'w', label: 'Counted by' }],
    rows: d.rows.slice(0, MAX_IN_CHAT).map((r) => ({
      d: dateText(new Date(r.date)), c: r.count + (r.status === 'APPROVED' ? '' : ` (${r.statusText.toLowerCase()})`), sy: qty(r.systemQty, r.unit), co: qty(r.countedQty, r.unit),
      df: r.difference === null ? '–' : r.difference === 0 ? 'matches' : signed(r.difference, r.unit), r: r.difference ? r.reason ?? '' : '', w: r.by ?? '',
    })),
    note: d.rows.length === 0 ? (d.notFound.length ? notFoundNote(d.notFound) : 'It has not been counted yet.') : d.rows.length > MAX_IN_CHAT || d.more ? `Showing ${MAX_IN_CHAT} of ${d.more ? `more than ${MAX_ROWS}` : d.rows.length}, newest first.` : undefined,
  }],
});

// ── get_job_cost_report ────────────────────────────────────────────────────────────────────────────
/** Material cost per job: value out less value back. Closed jobs use the cost stored when they closed. */
export const getJobCostReport = defineTool({
  name: 'get_job_cost_report', kind: 'read', roles: ['OWNER'],
  input: z.object({ from: dateIn, to: dateIn, customerId: idOpt, customerPoId: idOpt, includeOpen: flag.optional() }),
  handler: async (ctx, input) => {
    const all = !!input.includeOpen;
    const where: Prisma.JobWhereInput = {
      ...(input.customerId ? { customerId: input.customerId } : {}), ...(input.customerPoId ? { customerPoId: input.customerPoId } : {}),
      ...(all ? { status: { not: 'CANCELLED' }, ...(range(input.from, input.to) ? { jobDate: range(input.from, input.to) } : {}) } : { status: 'CLOSED', ...(range(input.from, input.to) ? { closedAt: range(input.from, input.to) } : {}) }),
    };
    const jobs = await ctx.db.job.findMany({ where, include: { customer: { select: { name: true } }, customerPo: { select: { number: true } } }, orderBy: [{ closedAt: 'desc' }, { jobDate: 'desc' }, { number: 'desc' }], take: MAX_ROWS + 1 });
    const rows = [];
    for (const j of jobs.slice(0, MAX_ROWS)) {
      const cost = j.status === 'CLOSED' && j.materialCost !== null ? Number(j.materialCost) : await jobCost(ctx.db, j.id);
      rows.push({
        jobId: j.id, job: j.number, customer: j.customer.name, customerPo: j.customerPo?.number ?? null, product: j.productDescription, quantity: j.quantity,
        status: j.status, statusText: j.status === 'CLOSED' ? 'Closed' : j.status === 'OPEN' ? 'Open, nothing issued' : 'Open, material issued', materialCost: round2(cost),
        costPerPiece: j.quantity > 0 ? round2(cost / j.quantity) : null, closedAt: j.closedAt?.toISOString() ?? null,
      });
    }
    return { rows, more: jobs.length > MAX_ROWS, includesOpen: all, total: round2(rows.reduce((s, r) => s + r.materialCost, 0)) };
  },
  view: (d) => [{
    kind: 'table',
    title: d.rows.length ? `Material cost: ${inr(d.total)} across ${d.rows.length} job${d.rows.length === 1 ? '' : 's'}` : undefined,
    columns: [{ key: 'j', label: 'Job' }, { key: 'c', label: 'Customer' }, { key: 'q', label: 'Pieces', align: 'right' }, { key: 'k', label: 'Cost', align: 'right' }, { key: 'p', label: 'Per piece', align: 'right' }, { key: 's', label: 'Status' }],
    rows: d.rows.slice(0, MAX_IN_CHAT).map((r) => ({ j: r.job, c: r.customer, q: groupIndian(r.quantity), k: inr(r.materialCost), p: r.costPerPiece === null ? '–' : inr(r.costPerPiece), s: r.statusText })),
    note: d.rows.length === 0 ? (d.includesOpen ? 'There are no jobs for that.' : 'No job was closed in that time.') : d.rows.length > MAX_IN_CHAT || d.more ? `Showing ${MAX_IN_CHAT} of ${d.more ? `more than ${MAX_ROWS}` : d.rows.length}.` : d.includesOpen ? 'Open jobs show the cost so far.' : undefined,
  }],
});

// ── estimate_job_cost ──────────────────────────────────────────────────────────────────────────────
/**
 * A what-if for jobs not yet closed: the material each needs (the BOM, or more if more has gone out) priced at today's
 * average rates, against the same with one material's rate changed. Nothing is saved; no price changes anywhere.
 */
export const estimateJobCost = defineTool({
  name: 'estimate_job_cost', kind: 'read', roles: ['OWNER'],
  input: z.object({
    jobIds: z.array(z.string().min(1).max(64)).max(50).optional(), materialNames: names,
    newRate: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.number({ invalid_type_error: 'The rate must be a number.' }).positive('The rate must be more than zero.').max(100_000_000).optional()),
  }),
  handler: async (ctx, input) => {
    const found = await resolveMaterials(ctx.db, [], input.materialNames);
    if (found.asked && !found.ids.length) throw new ToolError('NOT_FOUND', `Couldn't find ${found.notFound.join(', ')}. Check the spelling.`, undefined, 'materialNames');
    if (found.ids.length && input.newRate === undefined) throw new ToolError('RATE_REQUIRED', 'What rate should I try? Say it per unit, like ₹900 per kg.', undefined, 'newRate');
    const jobs = await ctx.db.job.findMany({
      where: { status: { in: ['OPEN', 'MATERIAL_ISSUED', 'IN_PRODUCTION', 'COMPLETED'] }, ...(input.jobIds?.length ? { id: { in: input.jobIds } } : {}) },
      include: { customer: { select: { name: true } }, bomLines: { include: { material: { select: { name: true, uom: true } } } } }, orderBy: { number: 'asc' }, take: MAX_ROWS,
    });
    const rateOf = new Map((await ctx.db.stockBalance.findMany({ select: { materialId: true, averageRate: true } })).map((b) => [b.materialId, Number(b.averageRate)]));
    const changed = new Set(found.ids);
    const noRate = new Set<string>();
    const rows = [];
    for (const j of jobs) {
      const totals = await jobTotals(ctx.db, j.id);
      let now = 0;
      let est = 0;
      for (const l of j.bomLines) {
        const basis = Math.max(Number(l.requiredQty), totals.get(l.materialId)?.net ?? 0);
        const rate = rateOf.get(l.materialId) ?? 0;
        if (!rate && basis > 0) noRate.add(l.material.name);
        now += basis * rate;
        est += basis * (changed.has(l.materialId) && input.newRate !== undefined ? input.newRate : rate);
      }
      now = round2(now); est = round2(est);
      rows.push({ jobId: j.id, job: j.number, customer: j.customer.name, product: j.productDescription, quantity: j.quantity, currentCost: now, estimatedCost: est, change: round2(est - now), changePct: now > 0 ? round2(((est - now) / now) * 100) : null, costPerPiece: j.quantity > 0 ? round2(est / j.quantity) : null });
    }
    return {
      rows, notFound: found.notFound, newRate: input.newRate ?? null, noRate: [...noRate],
      totals: { current: round2(rows.reduce((s, r) => s + r.currentCost, 0)), estimated: round2(rows.reduce((s, r) => s + r.estimatedCost, 0)) },
    };
  },
  view: (d) => [{
    kind: 'table',
    title: d.rows.length ? `Open jobs: ${inr(d.totals.current)} now${d.newRate !== null ? `, ${inr(d.totals.estimated)} at the new rate` : ''}` : undefined,
    columns: [{ key: 'j', label: 'Job' }, { key: 'c', label: 'Customer' }, { key: 'n', label: 'Now', align: 'right' }, { key: 'e', label: 'If changed', align: 'right' }, { key: 'd', label: 'Change', align: 'right' }],
    rows: d.rows.slice(0, MAX_IN_CHAT).map((r) => ({ j: r.job, c: r.customer, n: inr(r.currentCost), e: inr(r.estimatedCost), d: r.change === 0 ? '–' : `${r.change > 0 ? '+' : '−'}${inr(Math.abs(r.change))}` })),
    note: d.rows.length === 0 ? 'There are no open jobs.' : [
      d.notFound.length ? notFoundNote(d.notFound) : '',
      d.noRate.length ? `No rate is known yet for ${d.noRate.join(', ')}, so they count as nothing.` : '',
      d.rows.length > MAX_IN_CHAT ? `Showing ${MAX_IN_CHAT} of ${d.rows.length}.` : '',
      'A what-if only: nothing is saved and no price changes.',
    ].filter(Boolean).join(' '),
  }],
});

// ── get_activity ───────────────────────────────────────────────────────────────────────────────────
const SOURCE: Record<string, string> = { AGENT: 'From the chat assistant', CHAT: 'From a form', LAUNCHER: 'From a button', ARTIFACT: 'From a page' };
const words = (tool: string) => { const w = tool.replace(/_/g, ' '); return w.charAt(0).toUpperCase() + w.slice(1); };

/** Who did what and when, from the audit log that nothing can edit. Owner only. */
export const getActivity = defineTool({
  name: 'get_activity', kind: 'read', roles: ['OWNER'],
  input: z.object({ userId: idOpt, from: dateIn, to: dateIn, tool: z.preprocess(emptyToUndef, z.string().regex(/^[a-z_]{1,64}$/, 'Use the action name, like issue_material.').optional()), jobId: idOpt }),
  handler: async (ctx, input) => {
    const where: Prisma.AuditEventWhereInput = {
      ...(input.userId ? { actorId: input.userId } : {}), ...(input.tool ? { toolName: input.tool } : {}),
      ...(range(input.from, input.to) ? { createdAt: range(input.from, input.to) } : {}), ...(input.jobId ? { entityType: 'Job', entityId: input.jobId } : {}),
    };
    const events = await ctx.db.auditEvent.findMany({ where, include: { actor: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: MAX_ROWS + 1 });
    return {
      rows: events.slice(0, MAX_ROWS).map((e) => {
        const after = (e.afterJson ?? {}) as Record<string, unknown>;
        const doc = typeof after.number === 'string' ? after.number : typeof after.job === 'string' ? after.job : null;
        return {
          id: e.id, when: e.createdAt.toISOString(), who: e.actor?.name ?? 'The system', what: e.toolName ? words(e.toolName) : `${e.action.charAt(0)}${e.action.slice(1).toLowerCase()} ${e.entityType}`,
          document: doc, source: SOURCE[e.openedFrom] ?? 'From a form', reason: e.reason,
        };
      }),
      more: events.length > MAX_ROWS,
    };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'w', label: 'When' }, { key: 'u', label: 'Who' }, { key: 'a', label: 'What' }, { key: 'd', label: 'Document' }, { key: 's', label: 'How' }],
    rows: d.rows.slice(0, MAX_IN_CHAT).map((r) => ({ w: `${dateText(new Date(r.when))} ${timeText(new Date(r.when))}`, u: r.who, a: r.what, d: r.document ?? '', s: r.source })),
    note: d.rows.length === 0 ? 'Nothing was done in that time.' : d.rows.length > MAX_IN_CHAT || d.more ? `Showing ${MAX_IN_CHAT} of ${d.more ? `more than ${MAX_ROWS}` : d.rows.length}, newest first.` : undefined,
  }],
});
