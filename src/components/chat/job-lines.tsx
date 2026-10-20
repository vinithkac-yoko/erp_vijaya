'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { PickerOption } from '@/lib/forms';
import { UOM_SHORT } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Picker } from './picker';

const box = 'block w-full min-h-12 rounded-md border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-faint aria-[invalid=true]:border-alert disabled:bg-paper';
const small = 'text-sm font-medium text-ink-soft';
const parse = (s: string) => { const t = s.replace(/,/g, '').trim(); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : NaN; };

export interface JobLineValue { materialId: string; quantity?: number; topUp?: boolean }
interface Row { key: number; materialId: string; unit: string; quantity: string; topUp: boolean }

/**
 * Material and how much, for part of an issue (with a tick for "extra, for rework") or for what came back from a job.
 * Nothing here takes a rate: issues and returns are valued at the current average, by the system.
 */
export function JobLinesEditor({ id, value, onChange, allowTopUp, unitLabel }: { id: string; value: JobLineValue[]; onChange: (v: JobLineValue[]) => void; allowTopUp: boolean; unitLabel: string }) {
  const next = useRef(1);
  const blank = (): Row => ({ key: next.current++, materialId: '', unit: '', quantity: '', topUp: false });
  const [rows, setRows] = useState<Row[]>(() => (value.length ? value : [{ materialId: '' }]).map((l) => ({ ...blank(), materialId: l.materialId, quantity: l.quantity === undefined ? '' : String(l.quantity), topUp: l.topUp === true })));

  const emit = useCallback((rs: Row[]) => onChange(rs.filter((r) => r.materialId).map((r) => {
    const q = parse(r.quantity);
    return { materialId: r.materialId, quantity: q ?? undefined, ...(allowTopUp && r.topUp ? { topUp: true } : {}) } as JobLineValue;
  })), [onChange, allowTopUp]);
  const update = (key: number, patch: Partial<Row>) => setRows((cur) => { const out = cur.map((r) => (r.key === key ? { ...r, ...patch } : r)); emit(out); return out; });
  useEffect(() => { emit(rows); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-3" role="group" aria-labelledby={`${id}-label`} data-testid="job-lines">
      {rows.map((r, i) => (
        <div key={r.key} role="group" aria-label={`Line ${i + 1}`} className="rounded-md border border-line bg-paper p-3">
          <div className="grid gap-2 md:grid-cols-[1fr_10rem]">
            <div>
              <span className={small}>Material</span>
              <Picker kind="material" id={`${id}-m${r.key}`} label={`Material, line ${i + 1}`} value={r.materialId} onChange={(m) => update(r.key, { materialId: m })}
                onOption={(o: PickerOption) => { if (o.unit) setRows((cur) => cur.map((x) => (x.key === r.key ? { ...x, unit: o.unit as string } : x))); }} />
            </div>
            <div>
              <label htmlFor={`${id}-q${r.key}`} className={small}>{unitLabel}</label>
              <div className="relative">
                <input id={`${id}-q${r.key}`} inputMode="decimal" autoComplete="off" disabled={!r.materialId} value={r.quantity} onChange={(e) => update(r.key, { quantity: e.target.value })} aria-label={`${unitLabel}, line ${i + 1}`} className={`${box} num pr-12 text-right`} />
                {r.unit && <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-soft">{UOM_SHORT[r.unit] ?? r.unit}</span>}
              </div>
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            {allowTopUp ? (
              <label className="flex min-h-11 items-center gap-3 font-medium">
                <input type="checkbox" checked={r.topUp} onChange={(e) => update(r.key, { topUp: e.target.checked })} aria-label={`Extra, for rework, line ${i + 1}`} className="size-5 accent-[var(--copper)]" />
                Extra, for rework
              </label>
            ) : <span />}
            <button type="button" aria-label={`Remove line ${i + 1}`} onClick={() => setRows((cur) => { const out = cur.length > 1 ? cur.filter((x) => x.key !== r.key) : [blank()]; emit(out); return out; })}
              className="inline-flex size-11 items-center justify-center rounded-md text-ink-soft hover:bg-copper-wash md:size-9"><Trash2 aria-hidden className="size-4" /></button>
          </div>
        </div>
      ))}
      <Button type="button" variant="secondary" size="sm" onClick={() => setRows((cur) => [...cur, blank()])}><Plus aria-hidden className="size-4" />Add a material</Button>
    </div>
  );
}
