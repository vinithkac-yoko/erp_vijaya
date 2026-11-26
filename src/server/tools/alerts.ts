import { z } from 'zod';
import { qty } from '@/lib/format';
import { defineTool } from './define';

interface AlertRow { name: string; uom: string; on_hand: string; minimumLevel: string; shortfall: string }

export const listReorderAlerts = defineTool({
  name: 'list_reorder_alerts', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({}),
  handler: async (ctx) => {
    const rows = await ctx.db.$queryRaw<AlertRow[]>`SELECT name, uom::text AS uom, on_hand, "minimumLevel", shortfall FROM v_reorder_alerts ORDER BY shortfall DESC, name`;
    return { rows: rows.map((r) => ({ material: r.name, unit: r.uom, onHand: Number(r.on_hand), minimumLevel: Number(r.minimumLevel), shortfall: Number(r.shortfall) })) };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'm', label: 'Material' }, { key: 'h', label: 'On hand', align: 'right' }, { key: 'min', label: 'Minimum', align: 'right' }, { key: 's', label: 'Short by', align: 'right' }],
    rows: d.rows.slice(0, 10).map((r) => ({ m: r.material, h: qty(r.onHand, r.unit), min: qty(r.minimumLevel, r.unit), s: qty(r.shortfall, r.unit) })),
    note: d.rows.length === 0 ? 'Nothing is below its minimum.' : d.rows.length > 10 ? `Showing 10 of ${d.rows.length}.` : undefined,
  }],
});
