'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Picker } from './picker';

export interface PartLineValue { partId: string; quantity?: number; rate?: number }
interface Row { key: number; partId: string; quantity: string; rate: string }

const box = 'block w-full min-h-12 rounded-md border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-faint aria-[invalid=true]:border-alert';
const parse = (s: string) => { const t = s.replace(/,/g, '').trim(); if (t === '') return undefined; const n = Number(t); return Number.isFinite(n) ? n : NaN; };

/**
 * The parts on a customer's order: one row per part with how many were ordered and, for the owner only, the rate the customer
 * pays for one piece. The parts offered are THIS customer's, so the customer is picked first.
 */
export function PartLinesEditor({ id, value, onChange, customerId, showRate, invalid, describedBy }: {
  id: string; value: PartLineValue[]; onChange: (v: PartLineValue[]) => void; customerId: string; showRate: boolean; invalid?: boolean; describedBy?: string;
}) {
  const next = useRef(1);
  const [rows, setRows] = useState<Row[]>(() => (value.length ? value : [{ partId: '' }]).map((l) => ({ key: next.current++, partId: l.partId, quantity: l.quantity === undefined ? '' : String(l.quantity), rate: l.rate === undefined ? '' : String(l.rate) })));
  const emit = useCallback((rs: Row[]) => onChange(rs.filter((r) => r.partId).map((r) => ({ partId: r.partId, quantity: parse(r.quantity), ...(showRate && parse(r.rate) !== undefined ? { rate: parse(r.rate) } : {}) }))), [onChange, showRate]);
  const update = (key: number, patch: Partial<Row>) => setRows((cur) => { const out = cur.map((r) => (r.key === key ? { ...r, ...patch } : r)); emit(out); return out; });
  useEffect(() => { emit(rows); /* the starting rows are the form's value */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-3" role="group" aria-labelledby={`${id}-label`} aria-describedby={describedBy} data-invalid={invalid || undefined} data-testid="part-lines">
      {!customerId && <p className="text-sm text-ink-soft">Pick the customer first, then the parts they ordered.</p>}
      {rows.map((r, i) => (
        <div key={r.key} role="group" aria-label={`Line ${i + 1}`} className="rounded-md border border-line bg-paper p-3">
          <div className={`grid gap-2 ${showRate ? 'md:grid-cols-[1fr_8rem_9rem]' : 'md:grid-cols-[1fr_9rem]'}`}>
            <div>
              <span className="text-sm font-medium text-ink-soft">Part number</span>
              <Picker kind="part" id={`${id}-p${r.key}`} label={`Part, line ${i + 1}`} value={r.partId} forId={customerId || undefined} waitFor={customerId ? undefined : 'Pick the customer first'} onChange={(p) => update(r.key, { partId: p })} />
            </div>
            <div>
              <label htmlFor={`${id}-q${r.key}`} className="text-sm font-medium text-ink-soft">Pieces</label>
              <input id={`${id}-q${r.key}`} inputMode="numeric" autoComplete="off" disabled={!r.partId} value={r.quantity} onChange={(e) => update(r.key, { quantity: e.target.value })}
                aria-label={`Pieces, line ${i + 1}`} className={`${box} num text-right`} />
            </div>
            {showRate && (
              <div>
                <label htmlFor={`${id}-r${r.key}`} className="text-sm font-medium text-ink-soft">Rate a piece</label>
                <div className="relative">
                  <input id={`${id}-r${r.key}`} inputMode="decimal" autoComplete="off" disabled={!r.partId} value={r.rate} onChange={(e) => update(r.key, { rate: e.target.value })}
                    aria-label={`Rate for one piece, line ${i + 1}`} className={`${box} num pl-7 text-right`} />
                  <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft">₹</span>
                </div>
              </div>
            )}
          </div>
          <div className="mt-2 flex justify-end">
            <button type="button" onClick={() => setRows((cur) => { const out = cur.length > 1 ? cur.filter((x) => x.key !== r.key) : [{ key: next.current++, partId: '', quantity: '', rate: '' }]; emit(out); return out; })}
              aria-label={`Remove line ${i + 1}`} className="inline-flex size-11 items-center justify-center rounded-md text-ink-soft hover:bg-copper-wash md:size-9"><Trash2 aria-hidden className="size-4" /></button>
          </div>
        </div>
      ))}
      <Button type="button" variant="secondary" size="sm" disabled={!customerId} onClick={() => setRows((cur) => [...cur, { key: next.current++, partId: '', quantity: '', rate: '' }])}><Plus aria-hidden className="size-4" />Add a part</Button>
    </div>
  );
}
