import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { materialNameKey } from '@/lib/names';
import { dateText, qty } from '@/lib/format';
import { search } from '@/lib/similar';
import { ToolError } from '../errors';
import { defineTool } from './define';
import { findJob } from './jobs';
import { notify } from './notifications';
import { tell, watch } from './stockmoves';
import type { Db } from './types';

const MAX_ROWS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const emptyToUndef = (v: unknown) => (v === '' || v === null ? undefined : v);
const idOpt = z.preprocess(emptyToUndef, z.string().min(1).max(64).optional());
const istDate = (ymd: string) => new Date(`${ymd}T00:00:00+05:30`);
const todayYmd = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const validYmd = (s: string) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };

/** A date as typed (2026-10-07) or as the assistant may say it (@today, @today-7d). */
const dateIn = z.preprocess((v) => {
  if (v === '' || v === null || v === undefined) return undefined;
  const m = /^@today(?:-(\d{1,3})d)?$/.exec(String(v).trim());
  if (!m) return v;
  return new Date(new Date(`${todayYmd()}T00:00:00Z`).getTime() - Number(m[1] ?? 0) * 86_400_000).toISOString().slice(0, 10);
}, z.string().refine(validYmd, 'That is not a real date.').optional());

const TYPE_TEXT: Record<string, string> = {
  OPENING: 'Opening stock', RECEIPT: 'Received', ISSUE: 'Given to a job', RETURN: 'Back from a job', REJECT_RETURN: 'Sent back to supplier', SCRAP_IN: 'Scrap collected',
  SCRAP_SALE: 'Scrap sold', COUNT_ADJUSTMENT: 'Count adjustment', REVERSAL: 'Reversal',
};

const include = {
  material: { select: { name: true, uom: true } }, job: { select: { number: true } }, actor: { select: { name: true } },
  grnLine: { select: { goodsReceipt: { select: { number: true } } } }, stockCountLine: { select: { stockCount: { select: { number: true } } } }, scrapSale: { select: { number: true } },
  reversedBy: { select: { id: true } }, reversalOf: { select: { type: true } },
} as const;
type Move = Prisma.StockMovementGetPayload<{ include: typeof include }>;

const rowOf = (m: Move) => ({
  id: m.id, materialId: m.materialId, jobId: m.jobId, date: m.movementDate.toISOString(), type: m.type, typeText: m.type === 'REVERSAL' && m.reversalOf ? `Reversal of ${TYPE_TEXT[m.reversalOf.type]?.toLowerCase() ?? 'an entry'}` : TYPE_TEXT[m.type] ?? m.type,
  material: m.material.name, unit: m.material.uom, quantity: Number(m.quantity), direction: m.direction, rate: Number(m.rate), value: Number(m.value),
  document: m.grnLine?.goodsReceipt.number ?? m.stockCountLine?.stockCount.number ?? m.scrapSale?.number ?? null, job: m.job?.number ?? null, by: m.actor?.name ?? null,
  source: m.actorType === 'AGENT' ? 'From the chat' : 'From a button', balanceAfter: Number(m.balanceQtyAfter), reversed: !!m.reversedBy, note: m.notes,
});

// ── get_movement_history ───────────────────────────────────────────────────────────────────────────
export const getMovementHistory = defineTool({
  name: 'get_movement_history', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ materialId: idOpt, materialNames: z.array(z.string().max(100)).max(20).optional(), jobId: idOpt, from: dateIn, to: dateIn }),
  handler: async (ctx, input) => {
    let materialIds: string[] | undefined = input.materialId ? [input.materialId] : undefined;
    const notFound: string[] = [];
    if (input.materialNames?.length) {
      const all = await ctx.db.material.findMany({ select: { id: true, name: true, nameKey: true } });
      materialIds = [...(materialIds ?? [])];
      for (const n of input.materialNames) {
        const exact = all.find((m) => m.nameKey === materialNameKey(n));
        const hits = exact ? [exact] : search(n, all, (m) => m.nameKey, (m) => m.name).slice(0, 3);
        if (!hits.length) notFound.push(n);
        materialIds.push(...hits.map((h) => h.id));
      }
    }
    const job = input.jobId ? await findJob(ctx.db, input.jobId) : null;
    const where: Prisma.StockMovementWhereInput = {
      ...(materialIds ? { materialId: { in: materialIds } } : {}), ...(job ? { jobId: job.id } : {}),
      ...(input.from || input.to ? { movementDate: { ...(input.from ? { gte: istDate(input.from) } : {}), ...(input.to ? { lte: new Date(istDate(input.to).getTime() + 86_399_000) } : {}) } } : {}),
    };
    const rows = await ctx.db.stockMovement.findMany({ where, include, orderBy: [{ movementDate: 'desc' }, { createdAt: 'desc' }], take: MAX_ROWS + 1 });
    return { rows: rows.slice(0, MAX_ROWS).map(rowOf), more: rows.length > MAX_ROWS, notFound };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'd', label: 'Date' }, { key: 't', label: 'What' }, { key: 'm', label: 'Material' }, { key: 'q', label: 'Quantity', align: 'right' }, { key: 'b', label: 'Balance', align: 'right' }],
    rows: d.rows.slice(0, 10).map((r) => ({ d: dateText(new Date(r.date)), t: r.typeText + (r.job ? ` · ${r.job}` : '') + (r.reversed ? ' (reversed)' : ''), m: r.material, q: `${r.direction === 'OUT' ? '−' : '+'}${qty(r.quantity, r.unit)}`, b: qty(r.balanceAfter, r.unit) })),
    note: d.rows.length === 0 ? (d.notFound.length ? `Couldn't find: ${d.notFound.join(', ')}. Check the spelling.` : 'Nothing has moved.') : d.rows.length > 10 || d.more ? `Showing 10 of ${d.more ? `more than ${MAX_ROWS}` : d.rows.length}.` : undefined,
  }],
});

// ── reverse_movement ───────────────────────────────────────────────────────────────────────────────
const REVERSIBLE = new Set(['ISSUE', 'RETURN', 'SCRAP_IN', 'SCRAP_SALE', 'RECEIPT']);

async function findMovement(db: Db, id: string): Promise<Move> {
  const m = UUID.test(id) ? await db.stockMovement.findUnique({ where: { id }, include }) : null;
  if (!m) throw new ToolError('NOT_FOUND', "Couldn't find that movement.", undefined, 'movementId');
  return m;
}

export const reverseMovement = defineTool({
  name: 'reverse_movement', kind: 'write', roles: ['OWNER'],
  input: z.object({
    movementId: z.string({ required_error: 'Choose the entry to reverse.' }).min(1, 'Choose the entry to reverse.').max(64),
    reason: z.string({ required_error: 'Say why.' }).trim().min(1, 'Say why.').max(300, 'Please keep it short.'),
  }),
  form: {
    title: 'Reverse an entry', verb: 'Reverse it', intro: 'A reversal is a new entry that undoes the old one. Both stay in the history; nothing is deleted or edited.',
    fields: [
      { name: 'movementId', label: 'Which entry?', type: 'movement', required: true },
      { name: 'reason', label: 'Why?', type: 'text', required: true },
    ],
  },
  stamp: 'ENTRY REVERSED',
  describe: (a) => [
    `${a.material}: ${qty(Number(a.quantity), String(a.unit))} ${String(a.typeText).toLowerCase()}${a.job ? ` · ${a.job}` : ''} reversed`,
    `Balance now ${qty(Number(a.balanceAfter), String(a.unit))}`, `Your reason: ${a.reason}`, 'Both entries stay in the history. The storekeeper is told.',
  ],
  preview: async (ctx, input) => {
    if (typeof input.movementId !== 'string' || !input.movementId) return { info: ['Which entry is wrong?'] };
    try {
      const m = await findMovement(ctx.db, input.movementId);
      const bal = Number((await ctx.db.stockBalance.findUnique({ where: { materialId: m.materialId } }))?.quantity ?? 0);
      const after = round4(m.direction === 'OUT' ? bal + Number(m.quantity) : bal - Number(m.quantity));
      const info = [`${qty(Number(m.quantity), m.material.uom)} ${m.material.name} · ${TYPE_TEXT[m.type]?.toLowerCase()}${m.job ? ` · ${m.job.number}` : ''} · ${dateText(m.movementDate)}`, `Balance now ${qty(bal, m.material.uom)}; after the reversal ${qty(after, m.material.uom)}.`];
      if (m.reversedBy) info.push('This has been reversed already.');
      if (!REVERSIBLE.has(m.type)) info.push("This kind of entry can't be reversed.");
      return { info, values: { movementId: m.id } };
    } catch (e) { return { info: [e instanceof ToolError ? e.message : 'Choose the entry.'] }; }
  },
  handler: async (ctx, input) => {
    const m = await findMovement(ctx.db, input.movementId);
    if (m.reversedBy) throw new ToolError('ALREADY_REVERSED', 'That entry has been reversed already. Each entry can be reversed once.', undefined, 'movementId');
    if (m.type === 'OPENING' || m.type === 'COUNT_ADJUSTMENT') throw new ToolError('NOT_REVERSIBLE', "Opening stock and count adjustments can't be reversed: they came from a count the owner approved. The next count corrects them.", undefined, 'movementId');
    if (m.type === 'REVERSAL') throw new ToolError('NOT_REVERSIBLE', "A reversal can't be reversed. If it was a mistake, make the original entry again.", undefined, 'movementId');
    if (m.type === 'REJECT_RETURN') throw new ToolError('NOT_REVERSIBLE', "Goods sent back to the supplier can't be reversed here. Record a new receipt if they were taken back.", undefined, 'movementId');
    if (m.type === 'RECEIPT') {
      const sentBack = await ctx.db.stockMovement.count({ where: { grnLineId: m.grnLineId, type: 'REJECT_RETURN' } });
      if (sentBack > 0) throw new ToolError('NOT_REVERSIBLE', "Part of this delivery was sent back, so it can't be reversed in one go. Ask for a corrected receipt instead.", undefined, 'movementId');
    }
    let job = null;
    if (m.jobId && (m.type === 'ISSUE' || m.type === 'RETURN')) {
      job = await findJob(ctx.db, m.jobId);
      if (job.status === 'CLOSED') throw new ToolError('JOB_CLOSED', `${job.number} is closed and its cost is fixed, so this can't be reversed.`, undefined, 'movementId');
    }
    const before = Number((await ctx.db.stockBalance.findUnique({ where: { materialId: m.materialId } }))?.quantity ?? 0);
    const direction = m.direction === 'OUT' ? 'IN' : 'OUT';
    await ctx.db.stockMovement.create({
      data: {
        materialId: m.materialId, type: 'REVERSAL', direction, quantity: m.quantity, rate: m.direction === 'OUT' ? m.rate : 0, reversalOfId: m.id, jobId: m.jobId, movementDate: ctx.now,
        notes: input.reason, actorType: ctx.actor.actorType, actorId: ctx.actor.actorId, agentRunId: ctx.actor.agentRunId, toolName: ctx.actor.toolName,
      },
    });

    // what the reversed entry had updated elsewhere
    if (job && m.type === 'ISSUE') {
      await ctx.db.jobBomLine.updateMany({ where: { jobId: job.id, materialId: m.materialId }, data: { issuedQty: { decrement: m.quantity } } });
      const left = await ctx.db.stockMovement.count({ where: { jobId: job.id, type: 'ISSUE', reversedBy: null } });
      if (left === 0 && job.status === 'MATERIAL_ISSUED') await ctx.db.job.update({ where: { id: job.id }, data: { status: 'OPEN' } });
    }
    if (job && m.type === 'RETURN') await ctx.db.jobBomLine.updateMany({ where: { jobId: job.id, materialId: m.materialId }, data: { returnedQty: { decrement: m.quantity } } });
    if (m.type === 'RECEIPT' && m.grnLineId) {
      const gl = await ctx.db.goodsReceiptLine.findUnique({ where: { id: m.grnLineId }, select: { purchaseOrderLineId: true, goodsReceipt: { select: { purchaseOrderId: true } } } });
      if (gl?.purchaseOrderLineId) {
        await ctx.db.purchaseOrderLine.update({ where: { id: gl.purchaseOrderLineId }, data: { receivedQty: { decrement: m.quantity } } });
        const poId = gl.goodsReceipt.purchaseOrderId;
        const po = poId ? await ctx.db.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } }) : null;
        if (po && ['RECEIVED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
          const full = po.lines.every((l) => Number(l.receivedQty) >= Number(l.quantity));
          const some = po.lines.some((l) => Number(l.receivedQty) > 0);
          await ctx.db.purchaseOrder.update({ where: { id: po.id }, data: { status: full ? 'RECEIVED' : some ? 'PARTIALLY_RECEIVED' : 'APPROVED' } });
        }
      }
    }

    const after = round4(m.direction === 'OUT' ? before + Number(m.quantity) : before - Number(m.quantity));
    const w = await watch(ctx.db, [m.materialId], new Map([[m.materialId, before]]));
    await tell(ctx.db, w, ctx.session.userId);
    const typeText = TYPE_TEXT[m.type] ?? m.type;
    await notify(ctx.db, [m.actorId], {
      type: 'MOVEMENT_REVERSED', title: 'An entry was corrected', body: `${qty(Number(m.quantity), m.material.uom)} ${m.material.name} (${typeText.toLowerCase()}${m.job ? `, ${m.job.number}` : ''}) was reversed by the owner: ${input.reason}`, entityType: 'StockMovement', entityId: m.id,
    }, ctx.session.userId);
    return {
      data: { material: m.material.name, unit: m.material.uom, quantity: Number(m.quantity), typeText, job: m.job?.number ?? null, balanceAfter: after, reason: input.reason },
      audit: { entityType: 'StockMovement', entityId: m.id, action: 'REVERSE', reason: input.reason, after: { material: m.material.name, unit: m.material.uom, quantity: Number(m.quantity), typeText, job: m.job?.number ?? null, balanceBefore: before, balanceAfter: after, reason: input.reason } },
    };
  },
  followUps: async (_ctx, _input, result) => {
    const r = result as { material: string; unit: string; balanceAfter: number };
    return { facts: [`${r.material} is now ${qty(r.balanceAfter, r.unit)}. The storekeeper has been told.`], chips: [] };
  },
});
