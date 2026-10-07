import { z } from 'zod';
import { inr, qty, UOM_SHORT } from '@/lib/format';
import { materialNameKey } from '@/lib/names';
import { search } from '@/lib/similar';
import { defineTool } from './define';
import type { Db } from './types';

const MAX_ROWS_IN_CHAT = 10;

/** Materials by the words people use; what could not be found is reported, not guessed. */
async function resolveByName(db: Db, words: string[]) {
  const all = await db.material.findMany({ select: { id: true, name: true, nameKey: true } });
  const ids = new Set<string>();
  const notFound: string[] = [];
  for (const w of words) {
    const exact = all.find((m) => m.nameKey === materialNameKey(w));
    const hits = exact ? [exact] : search(w, all, (m) => m.nameKey, (m) => m.name).slice(0, 3);
    if (!hits.length) notFound.push(w);
    for (const h of hits) ids.add(h.id);
  }
  return { ids: [...ids], notFound };
}

/** What the stock is worth now, from the running balances (never recomputed from the ledger by hand). Owner only. */
export const getStockValue = defineTool({
  name: 'get_stock_value', kind: 'read', roles: ['OWNER'],
  input: z.object({ materialNames: z.array(z.string().max(100)).max(20).optional() }),
  handler: async (ctx, input) => {
    const asked = input.materialNames?.length ? await resolveByName(ctx.db, input.materialNames) : null;
    const rows = await ctx.db.stockBalance.findMany({ where: { OR: [{ quantity: { not: 0 } }, { stockValue: { not: 0 } }], ...(asked ? { materialId: { in: asked.ids } } : {}) }, include: { material: { select: { name: true, uom: true } } } });
    const list = rows.map((b) => ({ materialId: b.materialId, material: b.material.name, unit: b.material.uom, quantity: Number(b.quantity), averageRate: Number(b.averageRate), value: Number(b.stockValue) }))
      .sort((a, b) => b.value - a.value || a.material.localeCompare(b.material));
    return { total: Math.round(list.reduce((s, r) => s + r.value, 0) * 100) / 100, rows: list, notFound: asked?.notFound ?? [], filtered: !!asked };
  },
  view: (d) => [{
    kind: 'table', title: `${d.filtered ? 'Stock value' : 'Total stock value'}: ${inr(d.total)}`,
    columns: [{ key: 'm', label: 'Material' }, { key: 'q', label: 'On hand', align: 'right' }, { key: 'r', label: 'Rate', align: 'right' }, { key: 'v', label: 'Value', align: 'right' }],
    rows: d.rows.slice(0, MAX_ROWS_IN_CHAT).map((r) => ({ m: r.material, q: qty(r.quantity, r.unit), r: `₹${r.averageRate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}/${UOM_SHORT[r.unit] ?? ''}`, v: inr(r.value) })),
    note: d.notFound.length ? `Couldn't find: ${d.notFound.join(', ')}. Check the spelling.` : d.rows.length === 0 ? (d.filtered ? 'None of that is in stock.' : 'There is no stock recorded yet.') : d.rows.length > MAX_ROWS_IN_CHAT ? `Showing the ${MAX_ROWS_IN_CHAT} biggest of ${d.rows.length}.` : undefined,
  }],
});
