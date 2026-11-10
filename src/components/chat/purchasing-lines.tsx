'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { PickerOption } from '@/lib/forms';
import { groupIndian, inr, UOM_SHORT } from '@/lib/format';
import { lastRateAction } from '@/server/chat/actions';
import { Button } from '@/components/ui/button';
import { Picker } from './picker';

const box = 'block w-full min-h-12 rounded-md border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-faint aria-[invalid=true]:border-alert disabled:bg-paper';
const small = 'text-sm font-medium text-ink-soft';
/** What a typed rate is compared with: under half or over double the last one paid is flagged here and asked about once by the server. */
const FAR_LOW = 0.5;
const FAR_HIGH = 2;

const parse = (s: string) => { const t = s.replace(/[₹,\s]/g, '').trim(); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : NaN; };
const text = (n: number | undefined) => (n === undefined ? '' : String(n));
const money = (n: number) => Math.round(n * 100) / 100;

interface Hint { rate: number; text: string }
/** The last rate paid for a material, fetched once per material. It is a hint, never a value in the box. */
function useHints() {
  const [hints, setHints] = useState<Record<string, Hint | null>>({});
  const asked = useRef(new Set<string>());
  const ask = useCallback((materialId: string) => {
    if (!materialId || asked.current.has(materialId)) return;
    asked.current.add(materialId);
    void lastRateAction({ materialId }).then((h) => setHints((cur) => ({ ...cur, [materialId]: h })));
  }, []);
  return { hints, ask };
}

/** The rate box, with the hint beneath it and "Use ₹812": pressing it is the person typing it. */
function RateBox({ id, label, value, onChange, hint, hintText, unit, invalid }: {
  id: string; label: string; value: string; onChange: (v: string) => void; hint?: number; hintText?: string; unit: string; invalid?: boolean;
}) {
  const typed = parse(value);
  const far = hint && typed !== null && !Number.isNaN(typed) && typed > 0 && (typed < hint * FAR_LOW || typed > hint * FAR_HIGH);
  return (
    <div>
      <label htmlFor={id} className={small}>{label}</label>
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft">₹</span>
        <input id={id} inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined} className={`${box} num pl-7 pr-12 text-right`} />
        {unit && <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-soft">/{unit}</span>}
      </div>
      {hintText && (
        <p className="mt-1 text-sm text-ink-soft" data-testid="rate-hint">
          {hintText}
          {hint !== undefined && value.trim() === '' && (
            <button type="button" onClick={() => onChange(String(hint))} className="ml-2 font-medium text-copper-deep underline underline-offset-2">Use ₹{hint.toLocaleString('en-IN', { maximumFractionDigits: 4 })}</button>
          )}
        </p>
      )}
      {far && <p className="mt-1 text-sm text-alert" role="status">That is far from the last rate (₹{hint?.toLocaleString('en-IN')}). Check it is not a slip.</p>}
    </div>
  );
}

// ── purchase order lines ───────────────────────────────────────────────────────────────────────────
export interface PoLineValue { materialId: string; quantity?: number; rate?: number; hsnCode?: string; gstRate?: number }
interface PoRow { key: number; materialId: string; unit: string; quantity: string; rate: string; hsn: string; gst: string }

/**
 * The lines of a purchase order: material, quantity, and the rate the person types from the supplier's quote. The line
 * amount and the total are worked out live, with whether the total is above the approval limit, so nobody is surprised
 * that a PO went to the owner (INTERFACE §6).
 */
export function PoLinesEditor({ id, value, onChange, limit }: { id: string; value: PoLineValue[]; onChange: (v: PoLineValue[]) => void; limit: number | null }) {
  const next = useRef(1);
  const { hints, ask } = useHints();
  const blank = (): PoRow => ({ key: next.current++, materialId: '', unit: '', quantity: '', rate: '', hsn: '', gst: '' });
  const [rows, setRows] = useState<PoRow[]>(() => (value.length ? value : [{ materialId: '' }]).map((l) => ({ ...blank(), materialId: l.materialId, quantity: text(l.quantity), rate: text(l.rate), hsn: l.hsnCode ?? '', gst: text(l.gstRate) })));

  const emit = useCallback((rs: PoRow[]) => onChange(rs.filter((r) => r.materialId).map((r) => {
    const q = parse(r.quantity), rt = parse(r.rate), g = parse(r.gst);
    return { materialId: r.materialId, quantity: q ?? undefined, rate: rt ?? undefined, hsnCode: r.hsn.trim() || undefined, gstRate: g ?? undefined } as PoLineValue;
  })), [onChange]);
  const update = (key: number, patch: Partial<PoRow>) => setRows((cur) => { const out = cur.map((r) => (r.key === key ? { ...r, ...patch } : r)); emit(out); return out; });
  useEffect(() => { emit(rows); rows.forEach((r) => ask(r.materialId)); /* the starting rows are the form's value */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let subtotal = 0, gstTotal = 0;
  for (const r of rows) {
    const q = parse(r.quantity), rt = parse(r.rate), g = parse(r.gst);
    if (q && rt && !Number.isNaN(q) && !Number.isNaN(rt)) { const a = q * rt; subtotal += a; if (g && !Number.isNaN(g)) gstTotal += (a * g) / 100; }
  }
  const total = money(subtotal + gstTotal);

  return (
    <div className="space-y-3" role="group" aria-labelledby={`${id}-label`} data-testid="po-lines">
      {rows.map((r, i) => {
        const q = parse(r.quantity), rt = parse(r.rate);
        const amount = q && rt && !Number.isNaN(q) && !Number.isNaN(rt) ? money(q * rt) : null;
        const h = r.materialId ? hints[r.materialId] : undefined;
        return (
          <div key={r.key} role="group" aria-label={`Line ${i + 1}`} className="rounded-md border border-line bg-paper p-3">
            <div className="grid gap-2 md:grid-cols-[1fr_8rem_9rem]">
              <div>
                <span className={small}>Material</span>
                <Picker kind="material" id={`${id}-m${r.key}`} label={`Material, line ${i + 1}`} value={r.materialId}
                  onChange={(m) => { update(r.key, { materialId: m }); ask(m); }} onOption={(o: PickerOption) => { if (o.unit) setRows((cur) => cur.map((x) => (x.key === r.key ? { ...x, unit: o.unit as string } : x))); ask(o.id); }} />
              </div>
              <div>
                <label htmlFor={`${id}-q${r.key}`} className={small}>Quantity</label>
                <div className="relative">
                  <input id={`${id}-q${r.key}`} inputMode="decimal" autoComplete="off" disabled={!r.materialId} value={r.quantity} onChange={(e) => update(r.key, { quantity: e.target.value })} aria-label={`Quantity, line ${i + 1}`} className={`${box} num pr-12 text-right`} />
                  {r.unit && <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-soft">{UOM_SHORT[r.unit] ?? r.unit}</span>}
                </div>
              </div>
              <RateBox id={`${id}-r${r.key}`} label={`Rate, line ${i + 1}`} value={r.rate} onChange={(v) => update(r.key, { rate: v })} hint={h?.rate} hintText={h?.text} unit={r.unit ? UOM_SHORT[r.unit] ?? '' : ''} />
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-[8rem_6rem_1fr_auto] sm:items-end">
              <div><label htmlFor={`${id}-h${r.key}`} className={small}>HSN (if known)</label><input id={`${id}-h${r.key}`} autoComplete="off" value={r.hsn} onChange={(e) => update(r.key, { hsn: e.target.value })} aria-label={`HSN, line ${i + 1}`} className={box} /></div>
              <div><label htmlFor={`${id}-g${r.key}`} className={small}>GST %</label><input id={`${id}-g${r.key}`} inputMode="decimal" autoComplete="off" value={r.gst} onChange={(e) => update(r.key, { gst: e.target.value })} aria-label={`GST, line ${i + 1}`} className={`${box} num text-right`} /></div>
              <p className="text-base" aria-live="polite" data-testid="po-amount"><span className="text-ink-soft">Amount: </span><span className="num font-semibold">{amount === null ? '–' : inr(amount)}</span></p>
              <button type="button" aria-label={`Remove line ${i + 1}`} onClick={() => setRows((cur) => { const out = cur.length > 1 ? cur.filter((x) => x.key !== r.key) : [blank()]; emit(out); return out; })}
                className="inline-flex size-11 items-center justify-center rounded-md text-ink-soft hover:bg-copper-wash md:size-9"><Trash2 aria-hidden className="size-4" /></button>
            </div>
          </div>
        );
      })}
      <Button type="button" variant="secondary" size="sm" onClick={() => setRows((cur) => [...cur, blank()])}><Plus aria-hidden className="size-4" />Add a material</Button>
      <div className="rounded-md border border-line bg-surface p-3" aria-live="polite" data-testid="po-total">
        <p className="text-lg"><span className="text-ink-soft">Total: </span><span className="num font-semibold">{inr(total)}</span>{gstTotal > 0 && <span className="ml-2 text-sm text-ink-soft">including GST {inr(money(gstTotal))}</span>}</p>
        {limit !== null && total > 0 && (
          <p className={total > limit ? 'font-medium text-attention' : 'text-confirm'} data-testid="po-limit">
            {total > limit ? `Above ${inr(limit)}: it goes to the owner to approve.` : `Within ${inr(limit)}: it is approved at once.`}
          </p>
        )}
      </div>
    </div>
  );
}

// ── goods receipt lines ────────────────────────────────────────────────────────────────────────────
export interface GrnLineValue {
  materialId: string; purchaseOrderLineId?: string; receivedQty?: number; acceptedQty?: number; rejectedQty?: number; rejectionReason?: string; rate?: number; hsnCode?: string; gstRate?: number;
  /** Hints only, from the PO: never sent. */ poRate?: number; due?: number; unit?: string;
}
interface GrnRow { key: number; materialId: string; poLineId?: string; unit: string; received: string; rejected: string; reason: string; rate: string; hsn: string; gst: string; poRate?: number; due?: number }

/**
 * What arrived, line by line. Every line is inspected: received = accepted + rejected, so the person types what arrived
 * and what goes back, and the accepted quantity is worked out and shown read-only (INTERFACE §6). The PO's rate sits
 * beside the empty rate box as a hint; the rate that counts is the one on the supplier's invoice.
 */
export function GrnLinesEditor({ id, value, onChange }: { id: string; value: GrnLineValue[]; onChange: (v: GrnLineValue[]) => void }) {
  const next = useRef(1);
  const { hints, ask } = useHints();
  const blank = (): GrnRow => ({ key: next.current++, materialId: '', unit: '', received: '', rejected: '', reason: '', rate: '', hsn: '', gst: '' });
  const [rows, setRows] = useState<GrnRow[]>(() => (value.length ? value : [{ materialId: '' }]).map((l) => ({
    ...blank(), materialId: l.materialId, poLineId: l.purchaseOrderLineId, unit: l.unit ?? '', received: text(l.receivedQty), rejected: text(l.rejectedQty), reason: l.rejectionReason ?? '', rate: text(l.rate),
    hsn: l.hsnCode ?? '', gst: text(l.gstRate), poRate: l.poRate, due: l.due,
  })));

  const emit = useCallback((rs: GrnRow[]) => onChange(rs.filter((r) => r.materialId).map((r) => {
    const rec = parse(r.received), rej = parse(r.rejected) ?? 0, rt = parse(r.rate), g = parse(r.gst);
    const ok = rec !== null && !Number.isNaN(rec) && !Number.isNaN(rej);
    return {
      materialId: r.materialId, purchaseOrderLineId: r.poLineId, receivedQty: rec ?? undefined, ...(ok ? { acceptedQty: Math.round((rec - rej) * 10_000) / 10_000, rejectedQty: rej } : {}),
      rejectionReason: r.reason.trim() || undefined, rate: rt ?? undefined, hsnCode: r.hsn.trim() || undefined, gstRate: g ?? undefined,
    } as GrnLineValue;
  })), [onChange]);
  const update = (key: number, patch: Partial<GrnRow>) => setRows((cur) => { const out = cur.map((r) => (r.key === key ? { ...r, ...patch } : r)); emit(out); return out; });
  useEffect(() => { emit(rows); rows.forEach((r) => ask(r.materialId)); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-3" role="group" aria-labelledby={`${id}-label`} data-testid="grn-lines">
      {rows.map((r, i) => {
        const rec = parse(r.received), rej = parse(r.rejected) ?? 0;
        const accepted = rec !== null && !Number.isNaN(rec) && !Number.isNaN(rej) ? Math.round((rec - rej) * 10_000) / 10_000 : null;
        const bad = accepted !== null && accepted < 0;
        const unit = UOM_SHORT[r.unit] ?? '';
        const h = r.materialId ? hints[r.materialId] : undefined;
        const hintText = r.poRate !== undefined ? `PO rate ₹${r.poRate.toLocaleString('en-IN', { maximumFractionDigits: 4 })}/${unit}` : h?.text;
        return (
          <div key={r.key} role="group" aria-label={`Line ${i + 1}`} className="rounded-md border border-line bg-paper p-3">
            <div>
              <span className={small}>Material</span>
              <Picker kind="material" id={`${id}-m${r.key}`} label={`Material, line ${i + 1}`} value={r.materialId} onChange={(m) => { update(r.key, { materialId: m, poLineId: undefined }); ask(m); }}
                onOption={(o: PickerOption) => { if (o.unit) setRows((cur) => cur.map((x) => (x.key === r.key ? { ...x, unit: o.unit as string } : x))); ask(o.id); }} />
              {r.due !== undefined && <p className="mt-1 text-sm text-ink-soft">Still due on the PO: {groupIndian(r.due)} {unit}</p>}
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <div>
                <label htmlFor={`${id}-a${r.key}`} className={small}>Arrived</label>
                <div className="relative"><input id={`${id}-a${r.key}`} inputMode="decimal" autoComplete="off" disabled={!r.materialId} value={r.received} onChange={(e) => update(r.key, { received: e.target.value })} aria-label={`Arrived, line ${i + 1}`} className={`${box} num pr-12 text-right`} />{unit && <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-soft">{unit}</span>}</div>
              </div>
              <div>
                <label htmlFor={`${id}-j${r.key}`} className={small}>Sent back (failed the check)</label>
                <div className="relative"><input id={`${id}-j${r.key}`} inputMode="decimal" autoComplete="off" disabled={!r.materialId} value={r.rejected} onChange={(e) => update(r.key, { rejected: e.target.value })} aria-label={`Sent back, line ${i + 1}`} className={`${box} num pr-12 text-right`} placeholder="0" />{unit && <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-ink-soft">{unit}</span>}</div>
              </div>
              <div>
                <span className={small}>Goes into stock</span>
                <p className={`flex min-h-12 items-center justify-end rounded-md border border-line bg-surface px-3 num text-base font-semibold ${bad ? 'text-alert' : ''}`} aria-live="polite" data-testid="grn-accepted" aria-label={`Accepted, line ${i + 1}`}>
                  {accepted === null ? '–' : `${groupIndian(accepted)} ${unit}`}
                </p>
              </div>
            </div>
            {rej > 0 && (
              <div className="mt-2"><label htmlFor={`${id}-w${r.key}`} className={small}>Why is it sent back?</label><input id={`${id}-w${r.key}`} autoComplete="off" value={r.reason} onChange={(e) => update(r.key, { reason: e.target.value })} aria-label={`Reason sent back, line ${i + 1}`} className={box} /></div>
            )}
            {bad && <p role="alert" className="mt-1 text-sm text-alert">More is sent back than arrived.</p>}
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_8rem_6rem_auto] sm:items-end">
              <RateBox id={`${id}-r${r.key}`} label={`Rate on the invoice, line ${i + 1}`} value={r.rate} onChange={(v) => update(r.key, { rate: v })} hint={r.poRate ?? h?.rate} hintText={hintText} unit={unit} />
              <div><label htmlFor={`${id}-h${r.key}`} className={small}>HSN</label><input id={`${id}-h${r.key}`} autoComplete="off" value={r.hsn} onChange={(e) => update(r.key, { hsn: e.target.value })} aria-label={`HSN, line ${i + 1}`} className={box} /></div>
              <div><label htmlFor={`${id}-g${r.key}`} className={small}>GST %</label><input id={`${id}-g${r.key}`} inputMode="decimal" autoComplete="off" value={r.gst} onChange={(e) => update(r.key, { gst: e.target.value })} aria-label={`GST, line ${i + 1}`} className={`${box} num text-right`} /></div>
              <button type="button" aria-label={`Remove line ${i + 1}`} onClick={() => setRows((cur) => { const out = cur.length > 1 ? cur.filter((x) => x.key !== r.key) : [blank()]; emit(out); return out; })}
                className="inline-flex size-11 items-center justify-center rounded-md text-ink-soft hover:bg-copper-wash md:size-9"><Trash2 aria-hidden className="size-4" /></button>
            </div>
          </div>
        );
      })}
      <Button type="button" variant="secondary" size="sm" onClick={() => setRows((cur) => [...cur, blank()])}><Plus aria-hidden className="size-4" />Add a material</Button>
    </div>
  );
}
