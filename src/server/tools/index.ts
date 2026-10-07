import { db } from '../db';
import { createPendingService } from './pending';
import { Registry } from './registry';
import { createRunTool } from './run-tool';
import type { RunOptions, ToolOutcome, ToolSession } from './types';

/**
 * The production tool registry. Milestone 3 onward adds the real tools here (one file per operation in
 * docs/TOOL_CATALOG.md, each built with defineTool). It is empty in milestone 2: the gateway is proven with the
 * same code against test tools in tests/gateway.test.ts.
 */
export const registry = new Registry([]);

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
