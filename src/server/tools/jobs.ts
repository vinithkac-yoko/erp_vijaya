import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { Card } from '@/lib/cards';
import { dateText, groupIndian, qty, UOM_LONG } from '@/lib/format';
import { ToolError } from '../errors';
import { defineTool } from './define';
import { flag, opt } from './helpers';
import { jobCost, jobTotals } from './jobcost';
import { findParty, tidy } from './lookup';
import { nextNumber } from './numbers';
import { todayIST } from './counts';
import type { Db } from './types';

// ── words and small helpers ────────────────────────────────────────────────────────────────────────
const STATUSES = ['OPEN', 'MATERIAL_ISSUED', 'IN_PRODUCTION', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const;
const STATUS_TEXT: Record<(typeof STATUSES)[number], string> = { OPEN: 'Open', MATERIAL_ISSUED: 'Material issued', IN_PRODUCTION: 'In production', COMPLETED: 'Completed', CLOSED: 'Closed', CANCELLED: 'Cancelled' };
const TYPE_TEXT = { PRODUCTION: 'Production', SAMPLE: 'Sample' } as const;
/** Above this many pieces the form asks "is that right?" once. */
export const UNUSUAL_PIECES = 100_000;
/** A per-piece quantity this small is probably a typo (or a wrong unit): asked once. */
export const UNUSUAL_PER_PIECE = 0.0001;
/** Pieces and sets are counted whole; a BOM line of "2.5 cores each" is a question, not a number to save. */
const WHOLE_UNITS = new Set(['NOS', 'SET']);
const MAX_ROWS = 200;

const num = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d));
const emptyToUndef = (v: unknown) => (v === '' || v === null ? undefined : v);
const validYmd = (s: string) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const dateOpt = z.preprocess(emptyToUndef, z.string().refine(validYmd, 'That is not a real date.').optional());
const dateReq = (what: string) => z.string({ required_error: `Choose the ${what}.`, invalid_type_error: `Choose the ${what}.` }).refine(validYmd, `That is not a real date. Choose the ${what}.`);
const istDate = (ymd: string) => new Date(`${ymd}T00:00:00+05:30`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A per-piece quantity as people say it: wire in grams, liquids in millilitres, the rest in their own unit. */
export function perPieceText(q: number, uom: string): string {
  if (uom === 'KG' && q < 1) return `${Number((q * 1000).toFixed(3))} g`;
  if (uom === 'LTR' && q < 1) return `${Number((q * 1000).toFixed(3))} ml`;
  return qty(q, uom);
}

const jobInclude = { customer: { select: { name: true } }, customerPo: { select: { number: true } }, parentJob: { select: { number: true } } } as const;
type JobRow = Prisma.JobGetPayload<{ include: typeof jobInclude }>;

/** The job, by its id, or by how people say it: "JOB-2627-0031" or just "31" (the newest year wins). */
export async function findJob(db: Db, ref: string): Promise<JobRow> {
  const r = ref.trim();
  if (UUID.test(r)) {
    const j = await db.job.findUnique({ where: { id: r }, include: jobInclude });
    if (j) return j;
  } else if (r) {
    const digits = r.replace(/^job[-\s]*/i, '');
    const j = await db.job.findFirst({ where: { OR: [{ number: { equals: r, mode: 'insensitive' } }, ...(/^\d+$/.test(digits) ? [{ number: { endsWith: `-${digits.padStart(4, '0')}` } }] : [])] }, orderBy: { jobDate: 'desc' }, include: jobInclude });
    if (j) return j;
  }
  throw new ToolError('NOT_FOUND', "Couldn't find that job. Check the number.", undefined, 'jobId');
}

const jobLabel = (j: Pick<JobRow, 'number' | 'quantity'> & { customer: { name: string } }) => `${j.number} · ${j.customer.name} · ${groupIndian(j.quantity)} pieces`;

/** The customer a form names: by id (the picker) or by name (the assistant). */
const findCustomer = (db: Db, input: { customerId?: string; customerName?: string }) => findParty(db, { id: input.customerId, name: input.customerName }, 'CUSTOMER');

// ── create_customer_po ─────────────────────────────────────────────────────────────────────────────
export const createCustomerPo = defineTool({
  name: 'create_customer_po', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    customerName: opt(150), customerId: z.preprocess(emptyToUndef, z.string().max(64).optional()),
    number: z.string({ required_error: "Type the customer's PO number." }).trim().min(1, "Type the customer's PO number.").max(60, 'That PO number is too long.'),
    poDate: dateOpt,
  }),
  form: {
    title: 'Record a customer PO', verb: 'Save PO',
    intro: 'The purchase order a customer sent us. Not one we send a supplier.',
    fields: [
      { name: 'customerId', label: 'Customer', type: 'party', partyRole: 'CUSTOMER', required: true },
      { name: 'number', label: "Customer's PO number", type: 'text', required: true, hint: 'As printed on their PO.' },
      { name: 'poDate', label: 'PO date', type: 'date' },
    ],
  },
  stamp: 'CUSTOMER PO SAVED', stampUpdate: 'CUSTOMER PO ALREADY SAVED',
  describe: (a) => [`${a.customer} · PO ${a.number}`, a.existing ? 'This PO was already recorded, so nothing new was added. Each item they release is a new job under it.' : 'Each item they release is its own job.', ...(a.jobs ? [`${a.jobs} job${a.jobs === 1 ? '' : 's'} so far`] : [])],
  preview: async (ctx, input) => {
    const values: Record<string, unknown> = {};
    const info: string[] = [];
    if (!input.customerId && typeof input.customerName === 'string' && input.customerName.trim()) {
      try { values.customerId = (await findCustomer(ctx.db, { customerName: input.customerName })).id; } catch (e) { info.push(e instanceof ToolError ? e.message : 'Choose the customer.'); }
    }
    return { info, values };
  },
  handler: async (ctx, input) => {
    const customer = await findCustomer(ctx.db, input);
    const number = tidy(input.number);
    const found = await ctx.db.customerPo.findFirst({ where: { customerId: customer.id, number: { equals: number, mode: 'insensitive' } }, include: { _count: { select: { jobs: true } } } });
    if (found) {
      return {
        data: { id: found.id, customer: customer.name, number: found.number, existing: true },
        audit: { entityType: 'CustomerPo', entityId: found.id, action: 'REUSE', after: { customer: customer.name, number: found.number, existing: true, jobs: found._count.jobs } },
      };
    }
    const po = await ctx.db.customerPo.create({ data: { customerId: customer.id, number, poDate: input.poDate ? istDate(input.poDate) : null } });
    return {
      data: { id: po.id, customer: customer.name, number: po.number, existing: false },
      audit: { entityType: 'CustomerPo', entityId: po.id, action: 'CREATE', after: { customer: customer.name, number: po.number, existing: false, date: input.poDate ? dateText(istDate(input.poDate)) : null } },
    };
  },
  followUps: async (_ctx, input, result) => {
    const r = result as { id: string };
    return { facts: [], chips: [{ label: 'Create a job for this PO', form: 'create_job', prefill: { customerId: input.customerId, customerPoId: r.id } }] };
  },
});

// ── list_customer_pos ──────────────────────────────────────────────────────────────────────────────
export const listCustomerPos = defineTool({
  name: 'list_customer_pos', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ customerId: z.preprocess(emptyToUndef, z.string().max(64).optional()), customerName: opt(150) }),
  handler: async (ctx, input) => {
    const customer = input.customerId || input.customerName ? await findCustomer(ctx.db, input) : null;
    const rows = await ctx.db.customerPo.findMany({ where: customer ? { customerId: customer.id } : {}, include: { customer: { select: { name: true } }, _count: { select: { jobs: true } } }, orderBy: { createdAt: 'desc' }, take: MAX_ROWS });
    return { rows: rows.map((p) => ({ id: p.id, customerId: p.customerId, customer: p.customer.name, number: p.number, date: p.poDate?.toISOString() ?? null, jobs: p._count.jobs })) };
  },
  view: (d) => [{
    kind: 'table', columns: [{ key: 'c', label: 'Customer' }, { key: 'n', label: 'PO' }, { key: 'd', label: 'Date' }, { key: 'j', label: 'Jobs', align: 'right' }],
    rows: d.rows.slice(0, 10).map((r) => ({ c: r.customer, n: r.number, d: r.date ? dateText(new Date(r.date)) : '–', j: String(r.jobs) })),
    note: d.rows.length === 0 ? 'There are no customer POs yet.' : d.rows.length > 10 ? `Showing 10 of ${d.rows.length}.` : undefined,
  }],
});

// ── create_job ─────────────────────────────────────────────────────────────────────────────────────
export const createJob = defineTool({
  name: 'create_job', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    customerId: z.string({ required_error: 'Choose the customer.' }).min(1, 'Choose the customer.').max(64),
    customerPoId: z.preprocess(emptyToUndef, z.string().max(64).optional()),
    productDescription: z.string({ required_error: 'Say what is being made.' }).trim().min(1, 'Say what is being made.').max(200, 'Please keep it short.'),
    quantity: z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/,/g, '')) : v),
      z.number({ required_error: 'How many pieces?', invalid_type_error: 'Type the number of pieces.' }).int('Pieces are whole numbers.').min(1, 'The quantity must be more than zero.').max(100_000_000, 'That is too many pieces.')),
    jobDate: dateReq('job date'),
    dueDate: dateOpt,
    type: z.preprocess(emptyToUndef, z.enum(['PRODUCTION', 'SAMPLE'], { errorMap: () => ({ message: 'Choose production or sample.' }) }).optional()),
    parentJobId: z.preprocess(emptyToUndef, z.string().max(64).optional()),
    confirmUnusual: flag.optional(),
  }),
  form: {
    title: 'New job', verb: 'Create job',
    fields: [
      { name: 'type', label: 'What kind of job?', type: 'select', required: true, options: [{ value: 'PRODUCTION', label: 'Production' }, { value: 'SAMPLE', label: 'Sample (before the main order)' }] },
      { name: 'customerId', label: 'Customer', type: 'party', partyRole: 'CUSTOMER', required: true },
      { name: 'customerPoId', label: "Customer's PO (if there is one)", type: 'customerPo', dependsOn: 'customerId', hint: 'Pick the customer first. Record the PO first if it is not in the list.' },
      { name: 'parentJobId', label: 'The main job this sample is for', type: 'job', pickerFilter: 'production', required: true, showWhen: { field: 'type', in: ['SAMPLE'] } },
      { name: 'productDescription', label: 'What is being made?', type: 'text', required: true, hint: 'In your words, like SMPS transformer 12V 2A.' },
      { name: 'quantity', label: 'Pieces', type: 'number', required: true, unit: 'pcs' },
      { name: 'jobDate', label: 'Job date', type: 'date', required: true },
      { name: 'dueDate', label: 'Due date (if given)', type: 'date' },
    ],
  },
  stamp: 'JOB CREATED',
  describe: (a) => [
    `${a.number}${a.type === 'SAMPLE' ? ' (sample)' : ''}`,
    `${a.customer} · ${groupIndian(Number(a.quantity))} pieces`,
    String(a.product),
    ...(a.po ? [`Customer PO ${a.po}`] : []),
    ...(a.parent ? [`Sample for ${a.parent}`] : []),
    'Next: add the bill of materials.',
  ],
  preview: async (ctx, input) => {
    const values: Record<string, unknown> = { jobDate: todayIST(), type: 'PRODUCTION' };
    // a PO named without its customer carries its customer
    if (typeof input.customerPoId === 'string' && !input.customerId) {
      const po = await ctx.db.customerPo.findUnique({ where: { id: input.customerPoId }, select: { customerId: true } });
      if (po) values.customerId = po.customerId;
    }
    if (typeof input.parentJobId === 'string' && !input.type) values.type = 'SAMPLE';
    return { info: [], values };
  },
  handler: async (ctx, input) => {
    const customer = await findCustomer(ctx.db, { customerId: input.customerId });
    const type = input.type ?? 'PRODUCTION';
    if (input.dueDate && input.dueDate < input.jobDate) throw new ToolError('INVALID_DATE', "The due date can't be before the job date.", undefined, 'dueDate');

    let po: { id: string; number: string; customerId: string } | null = null;
    if (input.customerPoId) {
      po = await ctx.db.customerPo.findUnique({ where: { id: input.customerPoId }, select: { id: true, number: true, customerId: true } });
      if (!po) throw new ToolError('NOT_FOUND', "Couldn't find that customer PO.", undefined, 'customerPoId');
      if (po.customerId !== customer.id) throw new ToolError('CUSTOMER_PO_MISMATCH', `That PO belongs to a different customer, not ${customer.name}.`, undefined, 'customerPoId');
    }

    let parent: JobRow | null = null;
    if (type === 'SAMPLE') {
      if (!input.parentJobId) throw new ToolError('PARENT_REQUIRED', 'A sample belongs to a main job. Choose the main job it is for, or create that job first.', undefined, 'parentJobId');
      parent = await ctx.db.job.findUnique({ where: { id: input.parentJobId }, include: jobInclude });
      if (!parent) throw new ToolError('NOT_FOUND', "Couldn't find the main job.", undefined, 'parentJobId');
      if (parent.type === 'SAMPLE') throw new ToolError('PARENT_IS_SAMPLE', `${parent.number} is itself a sample. Choose the production job.`, undefined, 'parentJobId');
      if (parent.status === 'CANCELLED') throw new ToolError('PARENT_CANCELLED', `${parent.number} was cancelled.`, undefined, 'parentJobId');
    }

    if (input.quantity > UNUSUAL_PIECES && !input.confirmUnusual) {
      throw new ToolError('CONFIRM_UNUSUAL_QUANTITY', `${groupIndian(input.quantity)} pieces is a lot. Is that right?`, { quantity: input.quantity }, 'quantity');
    }

    const jobDate = istDate(input.jobDate);
    const job = await ctx.db.job.create({
      data: {
        number: await nextNumber(ctx.db, 'JOB', jobDate), customerId: customer.id, customerPoId: po?.id, type, parentJobId: parent?.id,
        productDescription: tidy(input.productDescription), quantity: input.quantity, jobDate, dueDate: input.dueDate ? istDate(input.dueDate) : null,
      },
    });
    return {
      data: { id: job.id, number: job.number, quantity: job.quantity, type },
      audit: {
        entityType: 'Job', entityId: job.id, action: 'CREATE',
        after: { number: job.number, type, customer: customer.name, product: job.productDescription, quantity: job.quantity, po: po?.number ?? null, parent: parent?.number ?? null, date: dateText(jobDate) },
      },
    };
  },
  followUps: async (_ctx, _input, result) => ({ facts: [], chips: [{ label: 'Add the BOM', form: 'set_job_bom', prefill: { jobId: (result as { id: string }).id } }] }),
});

// ── list_jobs ──────────────────────────────────────────────────────────────────────────────────────
const jobRowOf = (j: JobRow, owner: boolean) => ({
  id: j.id, number: j.number, customer: j.customer.name, customerPo: j.customerPo?.number ?? null, product: j.productDescription, quantity: j.quantity,
  type: j.type, typeText: TYPE_TEXT[j.type], status: j.status, statusText: STATUS_TEXT[j.status], jobDate: j.jobDate.toISOString(), dueDate: j.dueDate?.toISOString() ?? null,
  parentJob: j.parentJob?.number ?? null,
  // job cost is the owner's report: the storekeeper's copy has none (BUSINESS_FLOW, TOOL_CATALOG §3)
  materialCost: owner && j.status === 'CLOSED' ? num(j.materialCost) : null,
  costPerPiece: owner && j.status === 'CLOSED' && j.materialCost ? Math.round((Number(j.materialCost) / j.quantity) * 100) / 100 : null,
});

export const listJobs = defineTool({
  name: 'list_jobs', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    status: z.preprocess(emptyToUndef, z.enum(STATUSES).optional()), customerId: z.preprocess(emptyToUndef, z.string().max(64).optional()),
    customerPoId: z.preprocess(emptyToUndef, z.string().max(64).optional()), from: dateOpt, to: dateOpt,
  }),
  handler: async (ctx, input) => {
    const where: Prisma.JobWhereInput = {
      ...(input.status ? { status: input.status } : {}), ...(input.customerId ? { customerId: input.customerId } : {}), ...(input.customerPoId ? { customerPoId: input.customerPoId } : {}),
      ...(input.from || input.to ? { jobDate: { ...(input.from ? { gte: istDate(input.from) } : {}), ...(input.to ? { lte: new Date(istDate(input.to).getTime() + 86_399_000) } : {}) } } : {}),
    };
    const rows = await ctx.db.job.findMany({ where, include: jobInclude, orderBy: [{ jobDate: 'desc' }, { number: 'desc' }], take: MAX_ROWS });
    const owner = ctx.session.role === 'OWNER';
    return { rows: rows.map((j) => jobRowOf(j, owner)) };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'n', label: 'Job' }, { key: 'c', label: 'Customer' }, { key: 'p', label: 'Product' }, { key: 'q', label: 'Pieces', align: 'right' }, { key: 's', label: 'Status' }],
    rows: d.rows.slice(0, 10).map((r) => ({ n: r.number + (r.type === 'SAMPLE' ? ' (sample)' : ''), c: r.customer, p: r.product, q: groupIndian(r.quantity), s: r.statusText })),
    note: d.rows.length === 0 ? 'There are no jobs yet.' : d.rows.length > 10 ? `Showing 10 of ${d.rows.length}.` : undefined,
  }],
});

// ── get_job ────────────────────────────────────────────────────────────────────────────────────────
async function bomOf(db: Db, jobId: string, quantity: number) {
  const lines = await db.jobBomLine.findMany({ where: { jobId }, include: { material: { select: { name: true, uom: true } } }, orderBy: { material: { name: 'asc' } } });
  return lines.map((l) => ({
    materialId: l.materialId, material: l.material.name, unit: l.material.uom, qtyPerPiece: Number(l.qtyPerPiece), perPieceText: perPieceText(Number(l.qtyPerPiece), l.material.uom),
    required: Number(l.requiredQty), issued: Number(l.issuedQty), returned: Number(l.returnedQty), toIssue: Math.max(0, Number(l.requiredQty) - Number(l.issuedQty)),
    forQuantity: quantity,
  }));
}

export const getJob = defineTool({
  name: 'get_job', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ jobId: z.string({ required_error: 'Which job?' }).min(1, 'Which job?').max(64) }),
  handler: async (ctx, input) => {
    const j = await findJob(ctx.db, input.jobId);
    const bom = await bomOf(ctx.db, j.id, j.quantity);
    const owner = ctx.session.role === 'OWNER';
    let costSoFar: number | null = null;
    if (owner) {
      costSoFar = await jobCost(ctx.db, j.id);
    }
    return { job: jobRowOf(j, owner), bom, costSoFar };
  },
  view: (d) => {
    const j = d.job;
    const cards: Card[] = [{
      kind: 'table', title: `${j.number}${j.type === 'SAMPLE' ? ' (sample)' : ''} · ${j.customer} · ${groupIndian(j.quantity)} pieces · ${j.statusText}`,
      columns: [{ key: 'm', label: 'Material' }, { key: 'p', label: 'Per piece', align: 'right' }, { key: 't', label: 'Total needed', align: 'right' }, { key: 'i', label: 'Issued', align: 'right' }],
      rows: d.bom.slice(0, 12).map((b) => ({ m: b.material, p: b.perPieceText, t: qty(b.required, b.unit), i: qty(b.issued - b.returned, b.unit) })),
      note: d.bom.length === 0 ? `No bill of materials yet.${j.product ? ` ${j.product}.` : ''}` : j.product,
    }];
    return cards;
  },
});

// ── check_job_shortage ─────────────────────────────────────────────────────────────────────────────
export async function shortageOf(db: Db, jobRef: string) {
  const j = await findJob(db, jobRef);
  const lines = await db.jobBomLine.findMany({ where: { jobId: j.id }, include: { material: { include: { balance: true } } }, orderBy: { material: { name: 'asc' } } });
  const rows = lines.map((l) => {
    const needed = Math.max(0, Number(l.requiredQty) - Number(l.issuedQty));
    const inStock = Number(l.material.balance?.quantity ?? 0);
    return { materialId: l.materialId, material: l.material.name, unit: l.material.uom, needed, inStock, short: Math.max(0, Math.round((needed - Math.max(0, inStock)) * 10_000) / 10_000) };
  });
  return { jobId: j.id, number: j.number, customer: j.customer.name, quantity: j.quantity, rows, anyShort: rows.some((r) => r.short > 0), hasBom: lines.length > 0 };
}
type Shortage = Awaited<ReturnType<typeof shortageOf>>;

export const shortageCard = (d: Shortage): Card => ({
  kind: 'table', title: `${d.number} · what it still needs`,
  columns: [{ key: 'm', label: 'Material' }, { key: 'n', label: 'Needed', align: 'right' }, { key: 'h', label: 'In stock', align: 'right' }, { key: 's', label: 'Short', align: 'right' }],
  rows: d.rows.slice(0, 12).map((r) => ({ m: r.material, n: qty(r.needed, r.unit), h: qty(r.inStock, r.unit), s: r.short > 0 ? qty(r.short, r.unit) : '–' })),
  note: !d.hasBom ? 'There is no bill of materials yet.' : d.anyShort ? `${d.rows.filter((r) => r.short > 0).length} short.` : 'Nothing is short.',
});

export const checkJobShortage = defineTool({
  name: 'check_job_shortage', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ jobId: z.string({ required_error: 'Which job?' }).min(1, 'Which job?').max(64) }),
  handler: async (ctx, input) => shortageOf(ctx.db, input.jobId),
  view: (d) => [shortageCard(d)],
});

// ── get_job_bom_variance ───────────────────────────────────────────────────────────────────────────
export const getJobBomVariance = defineTool({
  name: 'get_job_bom_variance', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ jobId: z.string({ required_error: 'Which job?' }).min(1, 'Which job?').max(64) }),
  handler: async (ctx, input) => {
    const j = await findJob(ctx.db, input.jobId);
    const bom = await bomOf(ctx.db, j.id, j.quantity);
    const totals = await jobTotals(ctx.db, j.id);
    const tops = await ctx.db.stockMovement.findMany({ where: { jobId: j.id, type: 'ISSUE', reasonCode: 'TOP_UP', reversedBy: null }, select: { materialId: true, quantity: true } });
    const topUp = (materialId: string) => Math.round(tops.filter((t) => t.materialId === materialId).reduce((s, t) => s + Number(t.quantity), 0) * 10_000) / 10_000;
    const rows = bom.map((b) => {
      const used = Math.round(((totals.get(b.materialId)?.net) ?? (b.issued - b.returned)) * 10_000) / 10_000;
      const diff = Math.round((used - b.required) * 10_000) / 10_000;
      return { material: b.material, unit: b.unit, planned: b.required, used, difference: diff, differencePct: b.required > 0 ? Math.round((diff / b.required) * 10_000) / 100 : null, topUp: topUp(b.materialId) };
    });
    // material given out that was never on the BOM is all extra: planned nothing, used something
    const planned = new Set(bom.map((b) => b.materialId));
    const extra = [...totals.values()].filter((t) => !planned.has(t.materialId) && t.net > 0);
    if (extra.length) {
      const mats = await ctx.db.material.findMany({ where: { id: { in: extra.map((e) => e.materialId) } }, select: { id: true, name: true, uom: true } });
      for (const e of extra) { const m = mats.find((x) => x.id === e.materialId); if (m) rows.push({ material: m.name, unit: m.uom, planned: 0, used: e.net, difference: e.net, differencePct: null, topUp: topUp(e.materialId) }); }
    }
    return { number: j.number, rows };
  },
  view: (d) => [{
    kind: 'table', title: `${d.number} · planned against used`,
    columns: [{ key: 'm', label: 'Material' }, { key: 'p', label: 'Planned', align: 'right' }, { key: 'u', label: 'Used', align: 'right' }, { key: 'd', label: 'Difference', align: 'right' }],
    rows: d.rows.slice(0, 12).map((r) => ({ m: r.material, p: qty(r.planned, r.unit), u: qty(r.used, r.unit), d: `${r.differencePct === null ? (r.difference > 0 ? '+' : '') + qty(r.difference, r.unit) : `${r.difference > 0 ? '+' : ''}${qty(r.difference, r.unit)} (${r.differencePct > 0 ? '+' : ''}${r.differencePct}%)`}${r.topUp > 0 ? ` · ${qty(r.topUp, r.unit)} extra for rework` : ''}` })),
    note: d.rows.length === 0 ? 'There is no bill of materials yet.' : undefined,
  }],
});

// ── set_job_bom ────────────────────────────────────────────────────────────────────────────────────
const bomLine = z.object({
  materialId: z.string({ required_error: 'Choose the material.' }).min(1, 'Choose the material.').max(64),
  qtyPerPiece: z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/,/g, '')) : v),
    z.number({ required_error: 'Type the quantity for one piece.', invalid_type_error: 'Type the quantity for one piece, as a number.' }).gt(0, 'The quantity must be more than zero.').max(1_000_000, 'That is too big for one piece.')),
});

export const setJobBom = defineTool({
  name: 'set_job_bom', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    jobId: z.string({ required_error: 'Choose the job.' }).min(1, 'Choose the job.').max(64),
    lines: z.array(bomLine, { required_error: 'Add at least one material.' }).min(1, 'Add at least one material.').max(60, 'That is a lot of lines.'),
    confirmUnusual: flag.optional(),
  }),
  form: {
    title: 'Bill of materials', verb: 'Save BOM',
    intro: 'Quantities are for ONE piece. The total for the whole job is worked out for you.',
    fields: [
      { name: 'jobId', label: 'Job', type: 'job', pickerFilter: 'open', required: true },
      { name: 'lines', label: 'Materials, for one piece', type: 'lines', required: true },
    ],
  },
  stamp: 'BOM SAVED',
  describe: (a) => [
    `${a.number} · ${groupIndian(Number(a.quantity))} pieces`,
    ...((a.lines as { material: string; each: string; total: string }[]) ?? []).map((l) => `${l.material} — ${l.each} each → ${l.total}`),
  ],
  preview: async (ctx, input) => {
    if (typeof input.jobId !== 'string' || !input.jobId) return { info: [], values: {} };
    try {
      const j = await findJob(ctx.db, input.jobId);
      const values: Record<string, unknown> = { jobId: j.id, jobQuantity: j.quantity };
      const info = [jobLabel(j), j.productDescription];
      if (!input.lines) {
        const now = await bomOf(ctx.db, j.id, j.quantity);
        if (now.length) { values.lines = now.map((b) => ({ materialId: b.materialId, qtyPerPiece: b.qtyPerPiece })); info.push('This job already has a bill of materials. Saving replaces it.'); }
      }
      if (j.status !== 'OPEN') info.push(`The job is ${STATUS_TEXT[j.status].toLowerCase()}, so its bill of materials can't be changed. Extra material is a top-up issue.`);
      return { info, values };
    } catch { return { info: [], values: {} }; }
  },
  handler: async (ctx, input) => {
    const job = await findJob(ctx.db, input.jobId);
    if (job.status !== 'OPEN') {
      throw new ToolError('JOB_NOT_OPEN', `${job.number} is ${STATUS_TEXT[job.status].toLowerCase()}, so its bill of materials can't be changed any more. Extra material is a top-up issue.`, undefined, 'jobId');
    }
    const ids = input.lines.map((l) => l.materialId);
    const mats = await ctx.db.material.findMany({ where: { id: { in: ids } } });
    const byId = new Map(mats.map((m) => [m.id, m]));
    const seen = new Set<string>();
    const prepared = input.lines.map((l) => {
      const m = byId.get(l.materialId);
      if (!m || !m.isActive) throw new ToolError('NOT_FOUND', "One of those materials couldn't be found.", undefined, 'lines');
      if (seen.has(m.id)) throw new ToolError('DUPLICATE_LINE', `${m.name} is on the list twice. Put it on one line.`, undefined, 'lines');
      seen.add(m.id);
      if (WHOLE_UNITS.has(m.uom) && !Number.isInteger(l.qtyPerPiece)) {
        throw new ToolError('INVALID_QUANTITY', `${m.name} is counted in whole ${UOM_LONG[m.uom] ?? 'units'}. ${l.qtyPerPiece} each isn't possible. Do you mean a different unit?`, undefined, 'lines');
      }
      if (l.qtyPerPiece < 0.000001) {
        throw new ToolError('INVALID_QUANTITY', `${m.name}: ${l.qtyPerPiece} ${UOM_LONG[m.uom] ?? ''} for one piece is smaller than the system can keep. Did you mean a different unit?`, undefined, 'lines');
      }
      const per = new Prisma.Decimal(l.qtyPerPiece);
      if (per.decimalPlaces() > 6) throw new ToolError('INVALID_QUANTITY', `${m.name}: that is more decimal places than can be kept. Round it to 6 places.`, undefined, 'lines');
      const required = per.times(job.quantity).toDecimalPlaces(4);
      if (required.lte(0)) throw new ToolError('INVALID_QUANTITY', `${m.name}: the total for ${groupIndian(job.quantity)} pieces rounds to nothing. Check the unit.`, undefined, 'lines');
      return { m, per, required, tiny: l.qtyPerPiece < UNUSUAL_PER_PIECE };
    });
    const tiny = prepared.filter((p) => p.tiny);
    if (tiny.length && !input.confirmUnusual) {
      throw new ToolError('CONFIRM_UNUSUAL_QUANTITY', `${tiny.map((t) => `${t.m.name} at ${perPieceText(Number(t.per), t.m.uom)} each`).join(', ')} is unusually small for one piece. Is that right?`, { materials: tiny.map((t) => t.m.name) }, 'lines');
    }

    const before = await bomOf(ctx.db, job.id, job.quantity);
    await ctx.db.jobBomLine.deleteMany({ where: { jobId: job.id } });
    await ctx.db.jobBomLine.createMany({ data: prepared.map((p) => ({ jobId: job.id, materialId: p.m.id, qtyPerPiece: p.per, requiredQty: p.required })) });
    const lines = prepared.map((p) => ({ material: p.m.name, unit: p.m.uom, each: perPieceText(Number(p.per), p.m.uom), total: qty(Number(p.required), p.m.uom), qtyPerPiece: Number(p.per), required: Number(p.required) }))
      .sort((a, b) => a.material.localeCompare(b.material));
    return {
      data: { jobId: job.id, number: job.number, quantity: job.quantity, lines },
      audit: {
        entityType: 'Job', entityId: job.id, action: before.length ? 'UPDATE' : 'CREATE',
        before: { lines: before.map((b) => ({ material: b.material, each: b.perPieceText, total: qty(b.required, b.unit) })) },
        after: { number: job.number, quantity: job.quantity, lines },
      },
    };
  },
  followUps: async (ctx, _input, result) => {
    const r = result as { jobId: string };
    const sh = await ctx.read('check_job_shortage', { jobId: r.jobId });
    if (!sh.ok) return { facts: [], chips: [] };
    const d = sh.data as Shortage;
    const short = d.rows.filter((x) => x.short > 0);
    return {
      cards: [shortageCard(d)],
      facts: short.length
        ? [`The shortage check ran for ${d.number}: ${short.map((x) => `${x.material} needs ${qty(x.needed, x.unit)}, in stock ${qty(x.inStock, x.unit)}, short ${qty(x.short, x.unit)}`).join('; ')}.`]
        : [`The shortage check ran for ${d.number}: nothing is short.`],
      chips: short.length
        ? [{ label: 'Raise a PO for the shortfall', form: 'create_purchase_order', prefill: { triggeredByJobId: d.jobId, lines: short.map((x) => ({ materialId: x.materialId, quantity: x.short })) } }]
        : [{ label: 'Issue material now', form: 'issue_material', prefill: { jobId: d.jobId } }],
    };
  },
});

// ── cancel_job ─────────────────────────────────────────────────────────────────────────────────────
export const cancelJob = defineTool({
  name: 'cancel_job', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    jobId: z.string({ required_error: 'Choose the job.' }).min(1, 'Choose the job.').max(64),
    reason: z.string({ required_error: 'Say why.' }).trim().min(1, 'Say why.').max(300, 'Please keep it short.'),
  }),
  form: {
    title: 'Cancel a job', verb: 'Cancel job', intro: 'Only possible while no material has been issued to it.',
    fields: [
      { name: 'jobId', label: 'Job', type: 'job', pickerFilter: 'open', required: true },
      { name: 'reason', label: 'Why is it cancelled?', type: 'text', required: true },
    ],
  },
  stamp: 'JOB CANCELLED',
  describe: (a) => [String(a.number), `${a.customer} · ${groupIndian(Number(a.quantity))} pieces`, `Reason: ${a.reason}`],
  handler: async (ctx, input) => {
    const job = await findJob(ctx.db, input.jobId);
    if (job.status === 'CANCELLED') throw new ToolError('JOB_ALREADY_CANCELLED', `${job.number} is already cancelled.`, undefined, 'jobId');
    if (job.status === 'CLOSED' || job.status === 'COMPLETED') throw new ToolError('JOB_NOT_OPEN', `${job.number} is already ${STATUS_TEXT[job.status].toLowerCase()}, so it can't be cancelled.`, undefined, 'jobId');
    const moved = await ctx.db.stockMovement.count({ where: { jobId: job.id } });
    if (job.status !== 'OPEN' || moved > 0) throw new ToolError('JOB_HAS_ISSUES', `Material has been issued to ${job.number}, so it can't be cancelled. Return the material first.`, undefined, 'jobId');
    const samples = await ctx.db.job.count({ where: { parentJobId: job.id, status: { not: 'CANCELLED' } } });
    if (samples > 0) throw new ToolError('JOB_HAS_SAMPLES', `${job.number} still has a sample job under it. Cancel the sample first.`, undefined, 'jobId');
    await ctx.db.job.update({ where: { id: job.id }, data: { status: 'CANCELLED', notes: input.reason } });
    return {
      data: { number: job.number, customer: job.customer.name, quantity: job.quantity, reason: input.reason },
      audit: { entityType: 'Job', entityId: job.id, action: 'CANCEL', reason: input.reason, before: { status: job.status }, after: { number: job.number, customer: job.customer.name, quantity: job.quantity, reason: input.reason, status: 'CANCELLED' } },
    };
  },
});

export { jobLabel };
