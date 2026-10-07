import { db } from '../db';
import { listPendingApprovals } from './approvals';
import { listReorderAlerts } from './alerts';
import { approveStockCount, openCount, listCountLines, listCounts, rejectStockCount, saveCountSheet, startStockCount, submitCountLine, submitStockCount } from './counts';
import { cancelJob, checkJobShortage, createCustomerPo, createJob, getJob, getJobBomVariance, listCustomerPos, listJobs, setJobBom } from './jobs';
import { approvePurchaseOrder, cancelPurchaseOrder, createPurchaseOrder, getPurchaseOrder, getPurchasePriceHistory, listPurchaseOrders, rejectPurchaseOrder } from './purchasing';
import { listGoodsReceipts, recordGoodsReceipt } from './receipts';
import { createMaterial, deactivateMaterial, getMaterialBalance, searchMaterials, updateMaterial } from './materials';
import { createParty, deactivateParty, searchParties, updateParty } from './parties';
import { createPendingService } from './pending';
import { assistantSettingOn, listSettings, updateSetting } from './settings';
import { createUser, deactivateUser, listUsers, resetUserPassword } from './users';
import { getStockValue } from './stock';
import { Registry } from './registry';
import { createRunTool } from './run-tool';
import type { RunOptions, ToolOutcome, ToolSession } from './types';

/**
 * The production tool registry. One file per area; each tool is built with defineTool, which checks it against the
 * catalog (src/lib/catalog.ts, docs/TOOL_CATALOG.md). Later milestones add jobs, purchasing and stock movements.
 */
export const registry = new Registry([
  searchMaterials, getMaterialBalance, createMaterial, updateMaterial, deactivateMaterial,
  searchParties, createParty, updateParty, deactivateParty,
  listSettings, updateSetting,
  listUsers, createUser, resetUserPassword, deactivateUser,
  listReorderAlerts, listPendingApprovals, getStockValue,
  listCustomerPos, listJobs, getJob, checkJobShortage, getJobBomVariance, createCustomerPo, createJob, setJobBom, cancelJob,
  listPurchaseOrders, getPurchaseOrder, getPurchasePriceHistory, createPurchaseOrder, cancelPurchaseOrder, approvePurchaseOrder, rejectPurchaseOrder, listGoodsReceipts, recordGoodsReceipt,
  listCounts, listCountLines, startStockCount, submitCountLine, saveCountSheet, submitStockCount, approveStockCount, rejectStockCount,
]);

export const runTool = createRunTool(registry, db);
export const pendingActions = createPendingService(registry, db);

/**
 * What a form's button does: find the person's own form, then run its tool with that form as the confirmation. If the form
 * is no longer open (already saved, closed, timed out) the gateway says which, in plain words, instead of a vague "gone".
 */
export async function submitForm(session: ToolSession, pendingId: string, input: unknown): Promise<ToolOutcome> {
  const form = (await pendingActions.get(session, pendingId)) ?? (await pendingActions.peek(session, pendingId));
  if (!form) return { ok: false, code: 'CONFIRMATION_INVALID', message: "That form isn't open any more. Please open it again." };
  const opts: RunOptions = { confirmation: pendingId };
  return runTool(session, form.tool, input, opts);
}

export { ToolError } from '../errors';
export { defineTool } from './define';
export { conversations, conversationStore, startOfIndiaDay } from './conversations';
export type { Stored } from './conversations';
export { readSetting } from './settings';
export { notifications } from './notifications';
/** The count that is open right now (draft, sent back, or with the owner), if any. */
export const currentCount = () => openCount(db);
/** The owner's switch for the assistant (the environment variable is the hard stop; this is the one in Settings). */
export const assistantOn = () => assistantSettingOn(db);
export { nextNumber, nextCode } from './numbers';
export type { ToolSession, ToolOutcome } from './types';
