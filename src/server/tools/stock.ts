import { z } from 'zod';
import { inr, qty, UOM_SHORT } from '@/lib/format';
import { defineTool } from './define';

const MAX_ROWS_IN_CHAT = 10;

/** What the stock is worth now, from the running balances (never recomputed from the ledger by hand). Owner only. */
export const getStockValue = defineTool({
  name: 'get_stock_value', kind: 'read', roles: ['OWNER'],
  input: z.object({}),
  handler: async (ctx) => {
    const rows = await ctx.db.stockBalance.findMany({ where: { OR: [{ quantity: { not: 0 } }, { stockValue: { not: 0 } }] }, include: { material: { select: { name: true, uom: true } } } });
    const list = rows.map((b) => ({ materialId: b.materialId, material: b.material.name, unit: b.material.uom, quantity: Number(b.quantity), averageRate: Number(b.averageRate), value: Number(b.stockValue) }))
      .sort((a, b) => b.value - a.value || a.material.localeCompare(b.material));
    return { total: Math.round(list.reduce((s, r) => s + r.value, 0) * 100) / 100, rows: list };
  },
  view: (d) => [{
    kind: 'table', title: `Total stock value: ${inr(d.total)}`,
    columns: [{ key: 'm', label: 'Material' }, { key: 'q', label: 'On hand', align: 'right' }, { key: 'r', label: 'Rate', align: 'right' }, { key: 'v', label: 'Value', align: 'right' }],
    rows: d.rows.slice(0, MAX_ROWS_IN_CHAT).map((r) => ({ m: r.material, q: qty(r.quantity, r.unit), r: `₹${r.averageRate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}/${UOM_SHORT[r.unit] ?? ''}`, v: inr(r.value) })),
    note: d.rows.length === 0 ? 'There is no stock recorded yet.' : d.rows.length > MAX_ROWS_IN_CHAT ? `Showing the ${MAX_ROWS_IN_CHAT} biggest of ${d.rows.length}.` : undefined,
  }],
});
