import { z } from 'zod';
import { dateText, inr, qty } from '@/lib/format';
import { ToolError } from '../errors';
import { todayIST } from './counts';
import { defineTool } from './define';
import { opt } from './helpers';
import { findJob } from './jobs';
import { findParty } from './lookup';
import { nextNumber } from './numbers';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const emptyToUndef = (v: unknown) => (v === '' || v === null ? undefined : v);
const numeric = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/[₹,\s]/g, '')) : v === '' || v === null ? undefined : v);
const validYmd = (s: string) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const dateOpt = z.preprocess(emptyToUndef, z.string().refine(validYmd, 'That is not a real date.').optional());
const istDate = (ymd: string) => new Date(`${ymd}T00:00:00+05:30`);
const idOpt = z.preprocess(emptyToUndef, z.string().min(1).max(64).optional());
const matId = z.string({ required_error: 'Choose the scrap material.' }).min(1, 'Choose the scrap material.').max(64);
const quantity = z.preprocess(numeric, z.number({ required_error: 'How much?', invalid_type_error: 'Type the quantity as a number.' }).gt(0, 'The quantity must be more than zero.').max(1e9, 'That quantity is too big.'));

async function scrapMaterial(db: Parameters<typeof findJob>[0], id: string) {
  const m = await db.material.findUnique({ where: { id }, include: { balance: true } });
  if (!m || !m.isActive) throw new ToolError('NOT_FOUND', "Couldn't find that material.", undefined, 'materialId');
  if (!m.isScrap) throw new ToolError('NOT_SCRAP_MATERIAL', `${m.name} isn't a scrap material. Scrap goes into the material marked as scrap.`, undefined, 'materialId');
  return m;
}

// ── record_scrap_in ────────────────────────────────────────────────────────────────────────────────
export const recordScrapIn = defineTool({
  name: 'record_scrap_in', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ materialId: matId, quantity, jobId: idOpt }),
  form: {
    title: 'Scrap collected', verb: 'Add scrap to stock', intro: 'Copper offcuts collected off the floor. Name the job if you know which one they came from.',
    fields: [
      { name: 'materialId', label: 'Scrap material', type: 'material', pickerFilter: 'scrap', required: true },
      { name: 'quantity', label: 'How much', type: 'number', required: true },
      { name: 'jobId', label: 'From which job? (if known)', type: 'job' },
    ],
  },
  stamp: 'SCRAP ADDED',
  describe: (a) => [`${a.material}: ${qty(Number(a.quantity), String(a.unit))} collected`, ...(a.job ? [`From ${a.job}`] : []), `On hand now: ${qty(Number(a.balanceAfter), String(a.unit))}`],
  handler: async (ctx, input) => {
    const m = await scrapMaterial(ctx.db, input.materialId);
    const job = input.jobId ? await findJob(ctx.db, input.jobId) : null;
    if (job?.status === 'CANCELLED') throw new ToolError('JOB_NOT_OPEN', `${job.number} was cancelled.`, undefined, 'jobId');
    await ctx.db.stockMovement.create({
      data: { materialId: m.id, type: 'SCRAP_IN', direction: 'IN', quantity: input.quantity, rate: 0, jobId: job?.id, movementDate: ctx.now, actorType: ctx.actor.actorType, actorId: ctx.actor.actorId, agentRunId: ctx.actor.agentRunId, toolName: ctx.actor.toolName },
    });
    const after = Number((await ctx.db.stockBalance.findUniqueOrThrow({ where: { materialId: m.id } })).quantity);
    return {
      data: { material: m.name, unit: m.uom, quantity: input.quantity, job: job?.number ?? null, balanceAfter: after },
      audit: { entityType: 'Material', entityId: m.id, action: 'SCRAP_IN', after: { material: m.name, unit: m.uom, quantity: input.quantity, job: job?.number ?? null, balanceAfter: after } },
    };
  },
});

// ── record_scrap_sale ──────────────────────────────────────────────────────────────────────────────
export const recordScrapSale = defineTool({
  name: 'record_scrap_sale', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    materialId: matId, buyerId: z.string({ required_error: 'Choose the buyer.' }).min(1, 'Choose the buyer.').max(64), quantity,
    rate: z.preprocess(numeric, z.number({ required_error: 'Type the rate per unit.', invalid_type_error: 'Type the rate as a number.' }).gt(0, "Type the rate per unit. It can't be zero.").max(1e9, 'That rate is too big.')),
    saleDate: z.string({ required_error: 'Choose the date of the sale.' }).refine(validYmd, 'That is not a real date. Choose the date of the sale.'), invoiceNo: opt(60),
  }),
  form: {
    title: 'Scrap sold', verb: 'Record sale', intro: 'Sold to a scrap buyer. The buyer is one of your customers.',
    fields: [
      { name: 'materialId', label: 'Scrap material', type: 'material', pickerFilter: 'scrap', required: true },
      { name: 'buyerId', label: 'Buyer', type: 'party', partyRole: 'CUSTOMER', required: true },
      { name: 'quantity', label: 'How much was sold', type: 'number', required: true },
      { name: 'rate', label: 'Rate per unit', type: 'number', unit: '₹', required: true, hint: 'What the buyer pays per kg.' },
      { name: 'saleDate', label: 'Date of the sale', type: 'date', required: true },
      { name: 'invoiceNo', label: 'Invoice number (if any)', type: 'text' },
    ],
  },
  stamp: 'SCRAP SALE RECORDED',
  describe: (a) => [
    `${a.number} · ${a.buyer}`,
    `${a.material}: ${qty(Number(a.quantity), String(a.unit))} at ₹${Number(a.rate).toLocaleString('en-IN')} = ${inr(Number(a.amount))}`,
    ...(a.overBy ? [`Only ${qty(Number(a.onHandBefore), String(a.unit))} was on hand: ${qty(Number(a.overBy), String(a.unit))} more than collected. It is recorded, and flagged.`] : [`On hand now: ${qty(Number(a.balanceAfter), String(a.unit))}`]),
  ],
  preview: async () => ({ info: [], values: { saleDate: todayIST() } }),
  handler: async (ctx, input) => {
    if (input.saleDate > todayIST(ctx.now)) throw new ToolError('INVALID_DATE', "A sale can't be dated in the future.", undefined, 'saleDate');
    const m = await scrapMaterial(ctx.db, input.materialId);
    const buyer = await findParty(ctx.db, { id: input.buyerId }, 'CUSTOMER');
    const onHand = Number(m.balance?.quantity ?? 0);
    const amount = round2(input.quantity * input.rate);
    const date = istDate(input.saleDate);
    const sale = await ctx.db.scrapSale.create({ data: { number: await nextNumber(ctx.db, 'SCS', date), buyerId: buyer.id, materialId: m.id, saleDate: date, quantity: input.quantity, rate: input.rate, amount, invoiceNo: input.invoiceNo } });
    await ctx.db.stockMovement.create({
      data: { materialId: m.id, type: 'SCRAP_SALE', direction: 'OUT', quantity: input.quantity, rate: 0, scrapSaleId: sale.id, movementDate: date, actorType: ctx.actor.actorType, actorId: ctx.actor.actorId, agentRunId: ctx.actor.agentRunId, toolName: ctx.actor.toolName },
    });
    const overBy = onHand < input.quantity ? round4(input.quantity - Math.max(0, onHand)) : 0;
    const after = round4(onHand - input.quantity);
    return {
      data: { id: sale.id, number: sale.number, buyer: buyer.name, material: m.name, unit: m.uom, quantity: input.quantity, rate: input.rate, amount, onHandBefore: onHand, overBy, balanceAfter: after },
      audit: { entityType: 'ScrapSale', entityId: sale.id, action: 'CREATE', after: { number: sale.number, buyer: buyer.name, material: m.name, unit: m.uom, quantity: input.quantity, rate: input.rate, amount, onHandBefore: onHand, overBy, balanceAfter: after, invoiceNo: input.invoiceNo ?? null, date: dateText(date) } },
    };
  },
  followUps: async (_ctx, _input, result) => {
    const r = result as { material: string; unit: string; onHandBefore: number; overBy: number; quantity: number; balanceAfter: number };
    return { facts: r.overBy > 0 ? [`Only ${qty(Math.max(0, r.onHandBefore), r.unit)} of ${r.material} was recorded as collected, so this sale is ${qty(r.overBy, r.unit)} more than that. It is recorded, and flagged.`] : [`${qty(r.balanceAfter, r.unit)} of ${r.material} scrap is left.`], chips: [] };
  },
});

// ── get_scrap_summary ──────────────────────────────────────────────────────────────────────────────
export const getScrapSummary = defineTool({
  name: 'get_scrap_summary', kind: 'read', roles: ['OWNER'],
  input: z.object({ from: dateOpt, to: dateOpt }),
  handler: async (ctx, input) => {
    const when = input.from || input.to ? { movementDate: { ...(input.from ? { gte: istDate(input.from) } : {}), ...(input.to ? { lte: new Date(istDate(input.to).getTime() + 86_399_000) } : {}) } } : {};
    const mats = await ctx.db.material.findMany({ where: { isScrap: true, isActive: true }, include: { balance: true }, orderBy: { name: 'asc' } });
    const moves = await ctx.db.stockMovement.findMany({
      where: { materialId: { in: mats.map((m) => m.id) }, type: { in: ['SCRAP_IN', 'SCRAP_SALE'] }, ...when },
      include: { job: { select: { number: true } }, scrapSale: { select: { amount: true } }, reversedBy: { select: { id: true } } },
    });
    // a movement that was reversed no longer counts: the reversal undoes it
    const live = moves.filter((m) => !m.reversedBy);
    const rows = mats.map((m) => {
      const mine = live.filter((x) => x.materialId === m.id);
      const collected = round4(mine.filter((x) => x.type === 'SCRAP_IN').reduce((s, x) => s + Number(x.quantity), 0));
      const sold = round4(mine.filter((x) => x.type === 'SCRAP_SALE').reduce((s, x) => s + Number(x.quantity), 0));
      const byJob = new Map<string, number>();
      for (const x of mine.filter((y) => y.type === 'SCRAP_IN' && y.job)) byJob.set(x.job?.number ?? '', round4((byJob.get(x.job?.number ?? '') ?? 0) + Number(x.quantity)));
      return {
        materialId: m.id, material: m.name, unit: m.uom, collected, sold, onHand: Number(m.balance?.quantity ?? 0), saleValue: round2(mine.filter((x) => x.type === 'SCRAP_SALE').reduce((s, x) => s + Number(x.scrapSale?.amount ?? 0), 0)),
        byJob: [...byJob.entries()].map(([job, q]) => ({ job, quantity: q })),
        matches: round4(collected - sold) === round4(Number(m.balance?.quantity ?? 0)),
      };
    });
    return { rows };
  },
  view: (d) => [{
    kind: 'table', columns: [{ key: 'm', label: 'Scrap' }, { key: 'c', label: 'Collected', align: 'right' }, { key: 's', label: 'Sold', align: 'right' }, { key: 'o', label: 'On hand', align: 'right' }, { key: 'v', label: 'Sale value', align: 'right' }],
    rows: d.rows.map((r) => ({ m: r.material, c: qty(r.collected, r.unit), s: qty(r.sold, r.unit), o: qty(r.onHand, r.unit), v: inr(r.saleValue) })),
    note: d.rows.length === 0 ? 'There is no scrap material yet.' : undefined,
  }],
});
