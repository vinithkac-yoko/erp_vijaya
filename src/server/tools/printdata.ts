import { z } from 'zod';
import { PRINT_TEMPLATES } from '@/lib/catalog';
import { SETTINGS } from '@/lib/settings';
import { ToolError } from '../errors';
import { defineTool } from './define';
import { jobCost, jobTotals } from './jobcost';
import { findJob } from './jobs';
import { findPo } from './purchasing';
import type { Db } from './types';

/**
 * Everything the five printouts need, read as the person asking (docs/ARTIFACTS.md §9). The templates are code; this is
 * only the facts. Internal: the assistant and artifacts never see this tool, only the printout route does. Names and
 * numbers people use on paper; never an id or a code.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOpt = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().min(1).max(64).optional());
const round2 = (n: number) => Math.round(n * 100) / 100;

async function company(db: Db) {
  const rows = await db.setting.findMany({ where: { key: { startsWith: 'company.' } } });
  const get = (key: string) => rows.find((r) => r.key === key)?.value ?? SETTINGS.find((s) => s.key === key)?.initial ?? '';
  return { name: get('company.name') || 'Vijaya Electronics', address: get('company.address'), gstin: get('company.gstin'), state: get('company.state'), phone: get('company.phone') };
}
const partyOf = (p: { name: string; addressLine: string | null; city: string | null; state: string | null; pincode: string | null; gstin: string | null; phone: string | null }) => ({
  name: p.name, address: [p.addressLine, [p.city, p.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', '), state: p.state ?? '', gstin: p.gstin ?? '', phone: p.phone ?? '',
});

async function findReceipt(db: Db, ref: string) {
  const include = { supplier: true, purchaseOrder: { select: { number: true } }, lines: { include: { material: { select: { name: true, uom: true } } }, orderBy: { id: 'asc' as const } } };
  const r = ref.trim();
  const row = UUID.test(r) ? await db.goodsReceipt.findUnique({ where: { id: r }, include })
    : await db.goodsReceipt.findFirst({ where: { OR: [{ number: { equals: r, mode: 'insensitive' } }, ...(/^\d+$/.test(r) ? [{ number: { endsWith: `-${r.padStart(4, '0')}` } }] : [])] }, orderBy: { receiptDate: 'desc' }, include });
  if (!row) throw new ToolError('NOT_FOUND', "Couldn't find that goods receipt. Check the number.", undefined, 'receiptId');
  return row;
}

async function findCount(db: Db, ref: string | undefined) {
  const r = (ref ?? '').trim();
  const include = { lines: { include: { material: { select: { name: true, uom: true } } }, orderBy: { material: { name: 'asc' as const } } } };
  const row = !r ? await db.stockCount.findFirst({ where: { status: { in: ['DRAFT', 'REJECTED'] } }, orderBy: { createdAt: 'desc' }, include })
    : UUID.test(r) ? await db.stockCount.findUnique({ where: { id: r }, include })
    : await db.stockCount.findFirst({ where: { OR: [{ number: { equals: r, mode: 'insensitive' } }, ...(/^\d+$/.test(r) ? [{ number: { endsWith: `-${r.padStart(4, '0')}` } }] : [])] }, include });
  if (!row) throw new ToolError('NOT_FOUND', r ? "Couldn't find that count. Check the number." : 'There is no count open to print. Name one.', undefined, 'countId');
  return row;
}

export const getPrintData = defineTool({
  name: 'get_print_data', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ template: z.enum(['purchase-order', 'goods-receipt-note', 'issue-slip', 'count-sheet', 'job-cost-sheet']), purchaseOrderId: idOpt, receiptId: idOpt, jobId: idOpt, countId: idOpt }),
  handler: async (ctx, input) => {
    const t = PRINT_TEMPLATES[input.template];
    if (!t || !t.roles.includes(ctx.session.role)) throw new ToolError('FORBIDDEN_ROLE', 'That printout is not available to you.');
    const co = await company(ctx.db);

    if (input.template === 'purchase-order') {
      if (!input.purchaseOrderId) throw new ToolError('NOT_FOUND', 'Which purchase order?', undefined, 'purchaseOrderId');
      const po = await findPo(ctx.db, input.purchaseOrderId);
      const supplier = await ctx.db.party.findUniqueOrThrow({ where: { id: po.supplier.id } });
      const intra = !!co.state && !!supplier.state && co.state.trim().toLowerCase() === supplier.state.trim().toLowerCase();
      const taxMode = po.lines.every((l) => !l.gstRate || Number(l.gstRate) === 0) ? 'NONE' : intra ? 'CGST_SGST' : 'IGST';
      return {
        template: input.template, company: co,
        po: { number: po.number, date: po.poDate.toISOString(), approved: po.status === 'APPROVED' || po.status === 'PARTIALLY_RECEIVED' || po.status === 'RECEIVED', status: po.status, expected: po.expectedDate?.toISOString() ?? null, job: po.triggeredByJob?.number ?? null, approvedAt: po.approvedAt?.toISOString() ?? null },
        supplier: partyOf(supplier), taxMode,
        lines: po.lines.map((l, i) => ({ n: i + 1, material: l.material.name, hsn: l.hsnCode ?? '', unit: l.material.uom, quantity: Number(l.quantity), rate: Number(l.rate), gstRate: l.gstRate === null ? 0 : Number(l.gstRate), amount: Number(l.amount) })),
        subTotal: Number(po.subTotal), gst: Number(po.gstAmount), total: Number(po.totalValue),
      };
    }

    if (input.template === 'goods-receipt-note') {
      if (!input.receiptId) throw new ToolError('NOT_FOUND', 'Which goods receipt?', undefined, 'receiptId');
      const g = await findReceipt(ctx.db, input.receiptId);
      return {
        template: input.template, company: co,
        grn: { number: g.number, date: g.receiptDate.toISOString(), po: g.purchaseOrder?.number ?? null, invoiceNo: g.supplierInvoiceNo ?? '', invoiceDate: g.supplierInvoiceDate?.toISOString() ?? null, challanNo: g.supplierDcNo ?? '' },
        supplier: partyOf(g.supplier),
        lines: g.lines.map((l, i) => ({ n: i + 1, material: l.material.name, unit: l.material.uom, received: Number(l.receivedQty), accepted: Number(l.acceptedQty), rejected: Number(l.rejectedQty), reason: l.rejectionReason ?? '', rate: Number(l.rate) })),
      };
    }

    if (input.template === 'issue-slip' || input.template === 'job-cost-sheet') {
      if (!input.jobId) throw new ToolError('NOT_FOUND', 'Which job?', undefined, 'jobId');
      const j = await findJob(ctx.db, input.jobId);
      const head = { number: j.number, customer: j.customer.name, customerPo: j.customerPo?.number ?? '', product: j.productDescription, pieces: j.quantity, date: j.jobDate.toISOString(), due: j.dueDate?.toISOString() ?? null, status: j.status, closedAt: j.closedAt?.toISOString() ?? null };
      const bom = await ctx.db.jobBomLine.findMany({ where: { jobId: j.id }, include: { material: { select: { name: true, uom: true } } }, orderBy: { material: { name: 'asc' } } });
      if (input.template === 'issue-slip') {
        return {
          template: input.template, company: co, job: head,
          lines: bom.map((l, i) => ({ n: i + 1, material: l.material.name, unit: l.material.uom, required: Number(l.requiredQty), issued: Number(l.issuedQty), toIssue: Math.max(0, round2((Number(l.requiredQty) - Number(l.issuedQty)) * 10_000) / 10_000) })),
        };
      }
      const totals = await jobTotals(ctx.db, j.id);
      const names = new Map((await ctx.db.material.findMany({ where: { id: { in: [...totals.keys()] } }, select: { id: true, name: true, uom: true } })).map((m) => [m.id, m]));
      const rows = [...totals.values()].map((t) => ({ material: names.get(t.materialId)?.name ?? '', unit: names.get(t.materialId)?.uom ?? '', issued: t.issued, returned: t.returned, net: t.net, value: t.value })).sort((a, b) => a.material.localeCompare(b.material));
      const cost = j.status === 'CLOSED' && j.materialCost !== null ? Number(j.materialCost) : await jobCost(ctx.db, j.id);
      return { template: input.template, company: co, job: head, lines: rows, cost: round2(cost), perPiece: j.quantity > 0 ? round2(cost / j.quantity) : null };
    }

    const c = await findCount(ctx.db, input.countId);
    return {
      template: input.template, company: co,
      count: { number: c.number, date: c.countDate.toISOString(), opening: c.isOpening, status: c.status },
      lines: c.lines.map((l, i) => ({ n: i + 1, material: l.material.name, unit: l.material.uom, system: c.isOpening ? null : Number(l.systemQty) })),
    };
  },
});
