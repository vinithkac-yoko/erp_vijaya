import { z } from 'zod';
import { materialNameKey } from '@/lib/names';
import { defineTool } from '@/server/tools/define';
import { ToolError } from '@/server/errors';
import { createPendingService } from '@/server/tools/pending';
import { Registry } from '@/server/tools/registry';
import { createRunTool } from '@/server/tools/run-tool';
import { nextCode } from '@/server/tools/numbers';
import type { ToolSession } from '@/server/tools/types';
import { makeUser, prisma } from './db';

/** What the test tools saw, so a test can prove a handler was (or was not) reached. */
export const seen = { createMaterial: [] as unknown[], listJobs: 0, createUser: 0 };
export const resetSeen = () => { seen.createMaterial.length = 0; seen.listJobs = 0; seen.createUser = 0; };

// Real catalog names (the gateway refuses anything else), test handlers.
const tools = [
  defineTool({
    name: 'create_material', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
    input: z.object({ name: z.string().min(1, 'Type the name.'), uom: z.enum(['KG', 'NOS', 'MTR', 'LTR']) }),
    handler: async (ctx, input) => {
      seen.createMaterial.push(input);
      const m = await ctx.db.material.create({
        data: { code: await nextCode(ctx.db, 'MAT'), name: input.name, nameKey: materialNameKey(input.name), uom: input.uom, stockType: 'PER_JOB' },
      });
      return { data: { name: m.name }, audit: { entityType: 'Material', entityId: m.id, action: 'CREATE', after: { name: m.name, uom: m.uom } } };
    },
  }),
  defineTool({
    name: 'create_user', kind: 'write', roles: ['OWNER'],
    input: z.object({ name: z.string().min(1), login: z.string().min(3), role: z.enum(['OWNER', 'STOREKEEPER']), password: z.string().min(10).optional() }),
    handler: async (ctx, input) => {
      seen.createUser++;
      const u = await ctx.db.user.create({ data: { name: input.name, email: input.login, role: input.role, passwordHash: `hashed:${input.password ?? 'none'}` } });
      // a careless tool that puts the hash and the password into its audit entry: the gateway must scrub them
      return { data: { name: u.name }, audit: { entityType: 'User', entityId: u.id, action: 'CREATE', after: { name: u.name, passwordHash: u.passwordHash, password: input.password, nested: { apiKey: 'sk-live-123', ok: 1 } } } };
    },
  }),
  defineTool({
    name: 'list_jobs', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
    input: z.object({ status: z.string().optional() }),
    handler: async (ctx) => { seen.listJobs++; return { jobs: await ctx.db.job.count() }; },
  }),
  // a write that breaks half-way through
  defineTool({
    name: 'cancel_job', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
    input: z.object({ jobId: z.string(), reason: z.string() }),
    handler: async (ctx) => {
      await ctx.db.material.create({ data: { code: await nextCode(ctx.db, 'MAT'), name: 'Half done', nameKey: 'halfdone', uom: 'KG', stockType: 'PER_JOB' } });
      throw new ToolError('JOB_NOT_FOUND', "Couldn't find that job.");
    },
  }),
  // a write that the DATABASE refuses (a CHECK) after writing something
  defineTool({
    name: 'issue_material', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
    input: z.object({ materialId: z.string(), quantity: z.number() }),
    handler: async (ctx, input) => {
      await ctx.db.stockMovement.create({ data: { materialId: input.materialId, type: 'SCRAP_IN', direction: 'IN', quantity: input.quantity, rate: 0, movementDate: ctx.now } });
      return { data: {}, audit: { entityType: 'StockMovement', entityId: 'x', action: 'CREATE' } };
    },
  }),
  // a write with a rate field, to prove a rate is never pre-filled
  defineTool({
    name: 'record_scrap_sale', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
    input: z.object({ quantity: z.number(), rate: z.number(), invoiceNo: z.string().optional() }),
    handler: async () => ({ data: {}, audit: { entityType: 'ScrapSale', entityId: 'x', action: 'CREATE' } }),
  }),
  // a write that forgets to say what it did
  defineTool({
    name: 'deactivate_material', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
    input: z.object({ materialId: z.string() }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (async (ctx: any, input: { materialId: string }) => {
      await ctx.db.material.update({ where: { id: input.materialId }, data: { isActive: false } });
      return { data: {} };
    }) as never,
  }),
];

export const registry = new Registry(tools);
export const runTool = createRunTool(registry, prisma);
export const pending = createPendingService(registry, prisma);

export async function session(role: 'OWNER' | 'STOREKEEPER' = 'STOREKEEPER'): Promise<ToolSession> {
  const u = await makeUser(role);
  return { userId: u.id, name: u.name, role };
}

/** Opens a form for the user and returns its id, the way a launcher button does. */
export async function openForm(s: ToolSession, tool: string, origin: 'LAUNCHER' | 'AGENT' | 'ARTIFACT' = 'LAUNCHER', extra: Record<string, unknown> = {}) {
  const r = await pending.create(s, { tool, origin, ...extra });
  if (!r.ok) throw new Error(`could not open form: ${r.message}`);
  return r.data.id;
}
