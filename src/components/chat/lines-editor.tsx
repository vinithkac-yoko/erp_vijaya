'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { PickerOption } from '@/lib/forms';
import { groupIndian, UOM_SHORT } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Picker } from './picker';

export interface BomLineValue { materialId: string; qtyPerPiece?: number }
interface Row { key: number; materialId: string; unit: string; text: string; small: boolean }

const box = 'block w-full min-h-12 rounded-md border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-faint aria-[invalid=true]:border-alert';
/** Wire is weighed in grams and varnish measured in millilitres; the system keeps kilograms and litres (BUSINESS_FLOW §8). */
const SMALL: Record<string, string> = { KG: 'g', LTR: 'ml' };
const BIG: Record<string, string> = { KG: 'kg', LTR: 'L' };

const toText = (n: number) => String(Number(n.toFixed(6)));
const parse = (s: string) => { const t = s.replace(/,/g, '').trim(); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : NaN; };
const baseOf = (r: Row) => { const n = parse(r.text); return n === null || Number.isNaN(n) ? null : r.small && SMALL[r.unit] ? n / 1000 : n; };

/**
 * The bill of materials as a form field: one row per material, with the quantity for ONE piece and, beside it, the
 * total for the whole job, worked out live and read-only. This is the most important check in the system
 * (BUSINESS_FLOW §8), so the total is always in front of the person before anything is saved.
 */
export function LinesEditor({ id, value, onChange, jobQuantity, invalid, describedBy }: {
  id: string; value: BomLineValue[]; onChange: (v: BomLineValue[]) => void; jobQuantity: number | null; invalid?: boolean; describedBy?: string;
}) {
  const next = useRef(1);
  const [rows, setRows] = useState<Row[]>(() => (value.length ? value : [{ materialId: '' }]).map((l) => ({
    key: next.current++, materialId: l.materialId, unit: '', text: l.qtyPerPiece === undefined ? '' : toText(l.qtyPerPiece), small: false,
  })));
  // When the rows came from a saved BOM (or the assistant), a quantity under 1 kg is shown in grams: that is how the shop says it.
  const decided = useRef(new Set<number>());

  const emit = useCallback((rs: Row[]) => onChange(rs.filter((r) => r.materialId).map((r) => ({ materialId: r.materialId, qtyPerPiece: baseOf(r) ?? undefined }))), [onChange]);
  const update = (key: number, patch: Partial<Row>) => setRows((cur) => { const out = cur.map((r) => (r.key === key ? { ...r, ...patch } : r)); emit(out); return out; });
  const unitKnown = (key: number, o: PickerOption) => {
    if (!o.unit) return;
    setRows((cur) => cur.map((r) => {
      if (r.key !== key) return r;
      if (decided.current.has(key) || !SMALL[o.unit as string]) return { ...r, unit: o.unit as string };
      decided.current.add(key);
      const n = parse(r.text);
      if (n !== null && !Number.isNaN(n) && n > 0 && n < 1) return { ...r, unit: o.unit as string, small: true, text: toText(n * 1000) };
      return { ...r, unit: o.unit as string };
    }));
  };

  useEffect(() => { emit(rows); /* the starting rows are the form's value */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-3" role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy} data-invalid={invalid || undefined} data-testid="bom-lines">
      {rows.map((r, i) => {
        const base = baseOf(r);
        const total = base !== null && jobQuantity ? base * jobQuantity : null;
        const unitShort = r.unit ? (UOM_SHORT[r.unit] ?? r.unit) : '';
        return (
          <div key={r.key} role="group" aria-label={`Line ${i + 1}`} className="rounded-md border border-line bg-paper p-3">
            <div className="grid gap-2 md:grid-cols-[1fr_11rem]">
              <div>
                <span className="text-sm font-medium text-ink-soft">Material</span>
                <Picker kind="material" id={`${id}-m${r.key}`} label={`Material, line ${i + 1}`} value={r.materialId} onChange={(m) => update(r.key, { materialId: m })} onOption={(o) => unitKnown(r.key, o)} />
              </div>
              <div>
                <label htmlFor={`${id}-q${r.key}`} className="text-sm font-medium text-ink-soft">For one piece</label>
                <div className="flex gap-1">
                  <input id={`${id}-q${r.key}`} inputMode="decimal" autoComplete="off" disabled={!r.materialId} value={r.text} placeholder={r.materialId ? '' : 'pick the material'}
                    onChange={(e) => update(r.key, { text: e.target.value })} aria-label={`Quantity for one piece, line ${i + 1}`} className={`${box} num min-w-0 flex-1 text-right`} />
                  {SMALL[r.unit] ? (
                    <select aria-label={`Unit, line ${i + 1}`} value={r.small ? 'small' : 'big'} onChange={(e) => {
                      const small = e.target.value === 'small';
                      const n = parse(r.text);
                      // switching the unit keeps the SAME amount: 18.4 g becomes 0.0184 kg
                      update(r.key, { small, text: n !== null && !Number.isNaN(n) ? toText(small ? n * 1000 : n / 1000) : r.text });
                    }} className={`${box} w-20 shrink-0 px-2`}>
                      <option value="small">{SMALL[r.unit]}</option>
                      <option value="big">{BIG[r.unit]}</option>
                    </select>
                  ) : <span className="flex w-12 shrink-0 items-center justify-center text-ink-soft" aria-hidden>{unitShort}</span>}
                </div>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="text-base" aria-live="polite" data-testid="bom-total">
                <span className="text-ink-soft">Total needed: </span>
                <span className="num font-semibold">{total === null ? '–' : `${groupIndian(Number(total.toFixed(4)))} ${unitShort}`}</span>
              </p>
              <button type="button" onClick={() => setRows((cur) => { const out = cur.length > 1 ? cur.filter((x) => x.key !== r.key) : [{ key: next.current++, materialId: '', unit: '', text: '', small: false }]; emit(out); return out; })}
                aria-label={`Remove line ${i + 1}`} className="inline-flex size-11 items-center justify-center rounded-md text-ink-soft hover:bg-copper-wash md:size-9"><Trash2 aria-hidden className="size-4" /></button>
            </div>
          </div>
        );
      })}
      {jobQuantity === null && <p className="text-sm text-ink-soft">Pick the job to see the total for the whole job.</p>}
      <Button type="button" variant="secondary" size="sm" onClick={() => setRows((cur) => [...cur, { key: next.current++, materialId: '', unit: '', text: '', small: false }])}><Plus aria-hidden className="size-4" />Add a material</Button>
    </div>
  );
}
