import type { PickerOption } from '@/lib/forms';
import { dateText, qty, UOM_SHORT } from '@/lib/format';
import { search } from '@/lib/similar';
import { runTool } from '../tools';
import type { ToolSession } from '../tools/types';

/**
 * Type-ahead for the pickers in forms. Goes through the same read tools as everything else, so a person only ever finds
 * what their role may read. The value is an id; what is shown is a name and a small second line. Never a code.
 */
export type PickerKind = 'material' | 'party' | 'user' | 'countLine' | 'customerPo' | 'job' | 'purchaseOrder' | 'movement';
export interface PickerScope { role?: 'SUPPLIER' | 'CUSTOMER'; /** The customer, for a customer PO. */ forId?: string; /** 'open' or 'production' for jobs; 'cancellable' or 'receivable' for purchase orders. */ filter?: string }

/** The materials of the count in progress: pick one to enter its count. Shows the System quantity (the owner dropped blind counting). */
async function countLineOptions(session: ToolSession, q: string, onlyId?: string): Promise<PickerOption[]> {
  const r = await runTool(session, 'list_count_lines', {});
  if (!r.ok) return [];
  const d = r.data as { count: { isOpening: boolean }; rows: { id: string; material: string; unit: string; systemQty: number | null; countedQty: number | null; missing: string | null }[] };
  const rows = onlyId ? d.rows.filter((x) => x.id === onlyId) : q.trim() ? search(q, d.rows, (x) => x.material.toLowerCase(), (x) => x.material) : d.rows;
  return rows.slice(0, 8).map((x) => ({
    id: x.id, label: x.material,
    secondary: d.count.isOpening ? (x.missing ? `still needs ${x.missing}` : 'done') : `System ${qty(x.systemQty ?? 0, x.unit)}${x.countedQty === null ? '' : ` · counted ${qty(x.countedQty, x.unit)}`}`,
  }));
}

/** A job to pick: its number first, then who and how many. The id stays inside. */
async function jobOptions(session: ToolSession, q: string, filter?: string, onlyId?: string): Promise<PickerOption[]> {
  const r = await runTool(session, 'list_jobs', filter === 'open' ? { status: 'OPEN' } : {});
  if (!r.ok) return [];
  let rows = (r.data as { rows: { id: string; number: string; customer: string; product: string; quantity: number; type: string; status: string }[] }).rows;
  if (filter === 'production') rows = rows.filter((x) => x.type === 'PRODUCTION' && x.status !== 'CANCELLED' && x.status !== 'CLOSED');
  if (filter === 'issuable') rows = rows.filter((x) => ['OPEN', 'MATERIAL_ISSUED', 'IN_PRODUCTION'].includes(x.status));
  if (filter === 'returnable' || filter === 'closable') rows = rows.filter((x) => ['MATERIAL_ISSUED', 'IN_PRODUCTION', 'COMPLETED'].includes(x.status));
  if (onlyId) rows = rows.filter((x) => x.id === onlyId);
  const needle = q.trim().toLowerCase();
  if (needle) rows = rows.filter((x) => `${x.number} ${x.customer} ${x.product}`.toLowerCase().includes(needle) || x.number.toLowerCase().endsWith(needle.replace(/^job[-\s]*/, '').padStart(4, '0')));
  return rows.slice(0, 8).map((x) => ({ id: x.id, label: x.number, secondary: `${x.customer} · ${x.quantity.toLocaleString('en-IN')} pcs`, quantity: x.quantity }));
}

/** A purchase order to pick: its number first, then the supplier, the total and where it stands. */
async function poOptions(session: ToolSession, q: string, filter?: string, onlyId?: string): Promise<PickerOption[]> {
  const r = await runTool(session, 'list_purchase_orders', {});
  if (!r.ok) return [];
  let rows = (r.data as { rows: { id: string; number: string; supplier: string; total: number; status: string; statusText: string }[] }).rows;
  if (filter === 'cancellable') rows = rows.filter((x) => ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(x.status));
  if (filter === 'receivable') rows = rows.filter((x) => ['PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED'].includes(x.status));
  if (onlyId) rows = rows.filter((x) => x.id === onlyId);
  const needle = q.trim().toLowerCase();
  if (needle) rows = rows.filter((x) => `${x.number} ${x.supplier}`.toLowerCase().includes(needle) || x.number.toLowerCase().endsWith(needle.replace(/^po[-\s]*/, '').padStart(4, '0')));
  return rows.slice(0, 8).map((x) => ({ id: x.id, label: x.number, secondary: `${x.supplier} · ₹${Math.round(x.total).toLocaleString('en-IN')} · ${x.statusText}` }));
}

/** An entry to correct: what it was, how much, which job, and when. Only entries that can be reversed, newest first. */
async function movementOptions(session: ToolSession, q: string, onlyId?: string): Promise<PickerOption[]> {
  const r = await runTool(session, 'get_movement_history', q.trim() ? { materialNames: [q] } : {});
  if (!r.ok) return [];
  let rows = (r.data as { rows: { id: string; date: string; type: string; typeText: string; material: string; unit: string; quantity: number; job: string | null; reversed: boolean }[] }).rows;
  if (onlyId) rows = rows.filter((x) => x.id === onlyId);
  else rows = rows.filter((x) => !x.reversed && ['ISSUE', 'RETURN', 'SCRAP_IN', 'SCRAP_SALE', 'RECEIPT'].includes(x.type));
  return rows.slice(0, 8).map((x) => ({ id: x.id, label: `${qty(x.quantity, x.unit)} ${x.material}`, secondary: `${x.typeText}${x.job ? ` · ${x.job}` : ''} · ${dateText(new Date(x.date))}` }));
}

async function customerPoOptions(session: ToolSession, q: string, customerId?: string, onlyId?: string): Promise<PickerOption[]> {
  if (!customerId && !onlyId) return [];
  const r = await runTool(session, 'list_customer_pos', { customerId });
  if (!r.ok) return [];
  let rows = (r.data as { rows: { id: string; number: string; date: string | null; jobs: number }[] }).rows;
  if (onlyId) rows = rows.filter((x) => x.id === onlyId);
  const needle = q.trim().toLowerCase();
  if (needle) rows = rows.filter((x) => x.number.toLowerCase().includes(needle));
  return rows.slice(0, 8).map((x) => ({ id: x.id, label: x.number, secondary: `${x.jobs} job${x.jobs === 1 ? '' : 's'}` }));
}

export async function pickerOptions(session: ToolSession, kind: PickerKind, query: string, scope: PickerScope = {}): Promise<PickerOption[]> {
  const q = query.slice(0, 100);
  const role = scope.role;
  if (kind === 'countLine') return countLineOptions(session, q);
  if (kind === 'job') return jobOptions(session, q, scope.filter);
  if (kind === 'purchaseOrder') return poOptions(session, q, scope.filter);
  if (kind === 'movement') return movementOptions(session, q);
  if (kind === 'customerPo') return customerPoOptions(session, q, scope.forId);
  if (kind === 'material') {
    const r = await runTool(session, 'search_materials', { query: q });
    if (!r.ok) return [];
    const all = (r.data as { rows: { id: string; name: string; unit: string; onHand: number; isScrap?: boolean }[] }).rows;
    return (scope.filter === 'scrap' ? all.filter((m) => m.isScrap) : all).slice(0, 8).map((m) => ({ id: m.id, label: m.name, secondary: UOM_SHORT[m.unit] ?? m.unit, unit: m.unit }));
  }
  if (kind === 'party') {
    const r = await runTool(session, 'search_parties', { query: q, role });
    if (!r.ok) return [];
    return (r.data as { rows: { id: string; name: string; type: string; city: string | null }[] }).rows.slice(0, 8).map((p) => ({ id: p.id, label: p.name, secondary: [p.type, p.city].filter(Boolean).join(' · ') }));
  }
  const r = await runTool(session, 'list_users', {});
  if (!r.ok) return []; // only the owner may list people
  const needle = q.trim().toLowerCase();
  return (r.data as { rows: { id: string; name: string; role: string; active: boolean }[] }).rows
    .filter((u) => u.active && (!needle || u.name.toLowerCase().includes(needle))).slice(0, 8).map((u) => ({ id: u.id, label: u.name, secondary: u.role }));
}

/** The name to show for an id the assistant pre-filled in a picker (the person sees a name, never the id). */
export async function pickerLabel(session: ToolSession, kind: PickerKind, id: string): Promise<PickerOption | null> {
  if (kind === 'countLine') return (await countLineOptions(session, '', id))[0] ?? null;
  if (kind === 'job') return (await jobOptions(session, '', undefined, id))[0] ?? null;
  if (kind === 'purchaseOrder') return (await poOptions(session, '', undefined, id))[0] ?? null;
  if (kind === 'movement') return (await movementOptions(session, '', id))[0] ?? null;
  if (kind === 'customerPo') return (await customerPoOptions(session, '', undefined, id))[0] ?? null;
  const all = await pickerOptions(session, kind, '', {});
  if (all.some((o) => o.id === id)) return all.find((o) => o.id === id) ?? null;
  // the short list is capped; look the id up through the same read tool without the cap
  if (kind === 'material') {
    const r = await runTool(session, 'search_materials', {});
    const m = r.ok ? (r.data as { rows: { id: string; name: string; unit: string }[] }).rows.find((x) => x.id === id) : undefined;
    return m ? { id, label: m.name, secondary: UOM_SHORT[m.unit] ?? m.unit, unit: m.unit } : null;
  }
  if (kind === 'party') {
    const r = await runTool(session, 'search_parties', {});
    const p = r.ok ? (r.data as { rows: { id: string; name: string; type: string; city: string | null }[] }).rows.find((x) => x.id === id) : undefined;
    return p ? { id, label: p.name, secondary: [p.type, p.city].filter(Boolean).join(' · ') } : null;
  }
  return null;
}
