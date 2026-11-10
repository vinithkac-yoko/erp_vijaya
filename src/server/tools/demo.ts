import { z } from 'zod';
import { ToolError } from '../errors';
import { seedDemo } from '../demo/seed';
import { defineTool } from './define';

/**
 * "Reset demo data" (VIJAYA prompt §7). The ledger is append-only, so wiping it takes TRUNCATE, and the database refuses that
 * unless this very transaction says `vijaya.allow_reset = 'on'`. Only this tool says it, and only when DEMO_MODE=true.
 * It clears the business data, the audit trail and the numbers; it keeps the logins, the settings and the chats. Then the
 * demo month is built again through the same tools the people use.
 */
const WIPE = ['materials', 'parties', 'number_series', 'audit_events', 'stock_movements', 'stock_counts', 'notifications'];

export const resetDemoData = defineTool({
  name: 'reset_demo_data', kind: 'write', roles: ['OWNER'],
  input: z.object({ confirm: z.preprocess((v) => v === true || v === 'true' || v === 'on', z.boolean()).refine((v) => v, 'Tick the box to say you are sure.') }),
  form: {
    title: 'Start the demo again', verb: 'Wipe and start again',
    intro: 'This clears all the stock, jobs, purchase orders and history in this demo copy, then fills in a fresh demo month. Logins and settings stay. It cannot be undone.',
    fields: [{ name: 'confirm', label: 'Yes, wipe the demo data and start again', type: 'checkbox', required: true }],
  },
  stamp: 'DEMO STARTED AGAIN',
  describe: () => ['The demo data was cleared and filled in again.', 'A fresh month of stock, jobs, purchase orders and counts is ready.'],
  handler: async (ctx) => {
    if (process.env.DEMO_MODE !== 'true') throw new ToolError('NOT_DEMO', 'This only works on the demo copy. It is switched off here so real stock is never wiped.');
    await ctx.db.$executeRawUnsafe(`SET LOCAL vijaya.allow_reset = 'on'`);
    await ctx.db.$executeRawUnsafe(`TRUNCATE ${WIPE.join(', ')} CASCADE`);
    const storekeeper = await ctx.db.user.findFirst({ where: { role: 'STOREKEEPER', isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } });
    const owner = { userId: ctx.session.userId, name: ctx.session.name, role: ctx.session.role } as const;
    return {
      data: { reset: true },
      audit: { entityType: 'Demo', entityId: 'demo', action: 'RESET', after: { wiped: WIPE } },
      afterCommit: () => seedDemo({ owner, storekeeper: storekeeper ? { userId: storekeeper.id, name: storekeeper.name, role: 'STOREKEEPER' } : owner }),
    };
  },
});
