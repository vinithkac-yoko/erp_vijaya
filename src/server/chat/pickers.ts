import type { PickerOption } from '@/lib/forms';
import { UOM_SHORT } from '@/lib/format';
import { runTool } from '../tools';
import type { ToolSession } from '../tools/types';

/**
 * Type-ahead for the pickers in forms. Goes through the same read tools as everything else, so a person only ever finds
 * what their role may read. The value is an id; what is shown is a name and a small second line. Never a code.
 */
export async function pickerOptions(session: ToolSession, kind: 'material' | 'party' | 'user', query: string, role?: 'SUPPLIER' | 'CUSTOMER'): Promise<PickerOption[]> {
  const q = query.slice(0, 100);
  if (kind === 'material') {
    const r = await runTool(session, 'search_materials', { query: q });
    if (!r.ok) return [];
    return (r.data as { rows: { id: string; name: string; unit: string; onHand: number }[] }).rows.slice(0, 8).map((m) => ({ id: m.id, label: m.name, secondary: UOM_SHORT[m.unit] ?? m.unit }));
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
export async function pickerLabel(session: ToolSession, kind: 'material' | 'party' | 'user', id: string): Promise<PickerOption | null> {
  const all = await pickerOptions(session, kind, '');
  if (all.some((o) => o.id === id)) return all.find((o) => o.id === id) ?? null;
  // the short list is capped; look the id up through the same read tool without the cap
  if (kind === 'material') {
    const r = await runTool(session, 'search_materials', {});
    const m = r.ok ? (r.data as { rows: { id: string; name: string; unit: string }[] }).rows.find((x) => x.id === id) : undefined;
    return m ? { id, label: m.name, secondary: UOM_SHORT[m.unit] ?? m.unit } : null;
  }
  if (kind === 'party') {
    const r = await runTool(session, 'search_parties', {});
    const p = r.ok ? (r.data as { rows: { id: string; name: string; type: string; city: string | null }[] }).rows.find((x) => x.id === id) : undefined;
    return p ? { id, label: p.name, secondary: [p.type, p.city].filter(Boolean).join(' · ') } : null;
  }
  return null;
}
