import type { ChatItem } from '@/lib/cards';
import { pendingActions, runTool } from '../tools';
import type { CountLineRow } from '../tools/counts';
import type { ToolOutcome, ToolSession } from '../tools/types';

export interface SheetData {
  count: { id: string; number: string; kind: string; isOpening: boolean; status: string; statusText: string; date: string; rejectionNote: string | null };
  counted: number; total: number; totalValue: number | null; rows: CountLineRow[];
}
export interface SheetEdit {
  stockCountLineId: string; countedQty?: number | null; reasonCode?: string | null; unitRate?: number | null; sourceInvoiceNo?: string | null; sourceInvoiceDate?: string | null;
}

/** The count in progress, for the sheet in the panel. Read through the same tool the assistant uses. */
export async function loadSheet(session: ToolSession): Promise<ToolOutcome<SheetData>> {
  const r = await runTool(session, 'list_count_lines', {});
  return r.ok ? { ok: true, data: r.data as SheetData } : r;
}

/**
 * The sheet saves a row as it is typed. Each save is the person's own form (the sheet itself), opened and sent in one go:
 * it still goes through the gateway with a PendingAction, so the same rules, the same one transaction and the same audit
 * row apply as for every other save. An empty box is "not given", so it is dropped before the tool sees it.
 */
export async function saveSheetRows(session: ToolSession, stockCountId: string, edits: SheetEdit[]): Promise<ToolOutcome<{ rows: CountLineRow[]; done: number; total: number }>> {
  const lines = edits.map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== null && v !== undefined && v !== '')));
  const form = await pendingActions.create(session, { tool: 'save_count_sheet', origin: 'LAUNCHER' });
  if (!form.ok) return form;
  const r = await runTool(session, 'save_count_sheet', { stockCountId, lines }, { confirmation: form.data.id });
  return r.ok ? { ok: true, data: r.data as { rows: CountLineRow[]; done: number; total: number }, auditId: r.auditId } : r;
}

export type { ChatItem };
