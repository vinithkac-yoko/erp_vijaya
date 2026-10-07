import { z } from 'zod';
import { dateText, inr } from '@/lib/format';
import { summarize } from './counts';
import { defineTool } from './define';

export const listPendingApprovals = defineTool({
  name: 'list_pending_approvals', kind: 'read', roles: ['OWNER'],
  input: z.object({}),
  handler: async (ctx) => {
    const [pos, counts] = await Promise.all([
      ctx.db.purchaseOrder.findMany({ where: { status: 'PENDING_APPROVAL' }, include: { supplier: { select: { name: true } }, triggeredByJob: { select: { number: true } } }, orderBy: { createdAt: 'asc' } }),
      ctx.db.stockCount.findMany({ where: { status: 'PENDING_APPROVAL' }, orderBy: { createdAt: 'asc' } }),
    ]);
    const countRows = await Promise.all(counts.map(async (c) => {
      const s = await summarize(ctx.db, c);
      return { id: c.id, number: c.number, kind: c.isOpening ? 'Opening count' : 'Stock count', summary: s.text, amount: c.isOpening ? s.totalValue : null, date: c.countDate.toISOString(), waitingSince: c.createdAt.toISOString() };
    }));
    return {
      purchaseOrders: pos.map((p) => ({ id: p.id, number: p.number, supplier: p.supplier.name, total: Number(p.totalValue), job: p.triggeredByJob?.number ?? null, waitingSince: p.createdAt.toISOString() })),
      counts: countRows,
    };
  },
  view: (d) => {
    const rows = [
      ...d.purchaseOrders.map((p) => ({ what: p.number, detail: `${p.supplier}${p.job ? ` · for ${p.job}` : ''}`, amount: inr(p.total), since: dateText(new Date(p.waitingSince)) })),
      ...d.counts.map((c) => ({ what: c.number, detail: `${c.kind} · ${c.summary}`, amount: c.amount === null ? '–' : inr(c.amount), since: dateText(new Date(c.waitingSince)) })),
    ];
    return [{
      kind: 'table',
      columns: [{ key: 'what', label: 'Waiting' }, { key: 'detail', label: 'What' }, { key: 'amount', label: 'Amount', align: 'right' }, { key: 'since', label: 'Since' }],
      rows, note: rows.length === 0 ? 'Nothing is waiting for you.' : undefined,
    }];
  },
});
