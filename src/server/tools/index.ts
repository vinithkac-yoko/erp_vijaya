import { db } from '../db';
import { listPendingApprovals } from './approvals';
import { listReorderAlerts } from './alerts';
import { createMaterial, deactivateMaterial, getMaterialBalance, searchMaterials, updateMaterial } from './materials';
import { createParty, deactivateParty, searchParties, updateParty } from './parties';
import { createPendingService } from './pending';
import { listSettings, updateSetting } from './settings';
import { createUser, deactivateUser, listUsers, resetUserPassword } from './users';
import { Registry } from './registry';
import { createRunTool } from './run-tool';
import type { RunOptions, ToolOutcome, ToolSession } from './types';

/**
 * The production tool registry. One file per area; each tool is built with defineTool, which checks it against the
 * catalog (src/lib/catalog.ts, docs/TOOL_CATALOG.md). Later milestones add jobs, purchasing, stock movements and counts.
 */
export const registry = new Registry([
  searchMaterials, getMaterialBalance, createMaterial, updateMaterial, deactivateMaterial,
  searchParties, createParty, updateParty, deactivateParty,
  listSettings, updateSetting,
  listUsers, createUser, resetUserPassword, deactivateUser,
  listReorderAlerts, listPendingApprovals,
]);

export const runTool = createRunTool(registry, db);
export const pendingActions = createPendingService(registry, db);

/** What a form's button does: load the person's own open form, then run its tool with that form as the confirmation. */
export async function submitForm(session: ToolSession, pendingId: string, input: unknown): Promise<ToolOutcome> {
  const form = await pendingActions.get(session, pendingId);
  if (!form) return { ok: false, code: 'CONFIRMATION_INVALID', message: "That form isn't open any more. Please open it again." };
  const opts: RunOptions = { confirmation: pendingId };
  return runTool(session, form.tool, input, opts);
}

export { ToolError } from '../errors';
export { defineTool } from './define';
export { nextNumber, nextCode } from './numbers';
export type { ToolSession, ToolOutcome } from './types';
