'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CircleAlert, Lock } from 'lucide-react';
import { loadSheetAction, saveSheetAction } from '@/server/chat/actions';
import type { SheetData, SheetEdit } from '@/server/chat/sheet';
import type { CountLineRow } from '@/server/tools/counts';
import { groupIndian, UOM_SHORT } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';

// "Don't know" first, as an equal choice: an honest "unexplained" is what the owner needs (BUSINESS_FLOW §11).
const REASONS = [['UNEXPLAINED', "Don't know"], ['SPILLAGE', 'Spillage'], ['EXTRA_WASTAGE', 'Extra wastage'], ['MISSING', 'Missing'], ['ENTRY_ERROR', 'Entry error']] as const;
type Filter = 'all' | 'uncounted' | 'different' | 'rate';
interface Local { counted: string; rate: string; invoice: string }

const cell = 'block w-full min-h-11 md:min-h-10 rounded-md border border-line bg-surface px-2 text-base text-ink aria-[invalid=true]:border-alert disabled:bg-paper disabled:text-ink-soft';
const text = (n: number | null) => (n === null ? '' : String(n));
const parse = (s: string) => { const t = s.replace(/,/g, '').trim(); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : NaN; };
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${groupIndian(Number(Math.abs(n).toFixed(4)))}`;

export function CountSheet({ onSend }: { onSend: () => void }) {
  const [data, setData] = useState<SheetData | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [server, setServer] = useState<Map<string, CountLineRow>>(new Map());
  const [local, setLocal] = useState<Record<string, Local>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [saving, setSaving] = useState(0);
  const [savedAt, setSavedAt] = useState(false);
  const [width, setWidth] = useState(720);
  const scroller = useRef<HTMLDivElement>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const adopt = useCallback((rows: CountLineRow[]) => {
    setServer((cur) => { const next = new Map(cur); for (const r of rows) next.set(r.id, r); return next; });
  }, []);

  useEffect(() => {
    let alive = true;
    void loadSheetAction().then((r) => {
      if (!alive) return;
      if (!r.ok) { setProblem(r.message); return; }
      setData(r.data);
      setServer(new Map(r.data.rows.map((x) => [x.id, x])));
      setLocal(Object.fromEntries(r.data.rows.map((x) => [x.id, { counted: text(x.countedQty), rate: text(x.unitRate), invoice: x.sourceInvoiceNo ?? '' }])));
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el); setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [data]);

  const opening = data?.count.isOpening ?? false;
  const editable = data ? ['DRAFT', 'REJECTED'].includes(data.count.status) : false;
  const compact = width < 560;

  const all = useMemo(() => (data ? data.rows.map((r) => server.get(r.id) ?? r) : []), [data, server]);
  const counted = all.filter((r) => r.countedQty !== null).length;
  const noQty = all.filter((r) => r.countedQty === null).length;
  const noRate = all.filter((r) => r.missing === 'rate').length;
  const different = all.filter((r) => r.difference !== null && r.difference !== 0).length;
  const shown = useMemo(() => all.filter((r) => filter === 'all' ? true : filter === 'uncounted' ? r.countedQty === null : filter === 'different' ? !!r.difference : r.missing === 'rate'), [all, filter]);

  const rowHeight = compact ? (opening ? 132 : 148) : 64;
  const virt = useVirtualizer({ count: shown.length, getScrollElement: () => scroller.current, estimateSize: () => rowHeight, overscan: 8 });
  useEffect(() => { virt.measure(); }, [rowHeight, filter, virt]);

  /** Sheet saves go one after another, so a quick typist never overtakes themselves. */
  const save = useCallback((id: string, edit: Omit<SheetEdit, 'stockCountLineId'>) => {
    if (!data) return;
    setSaving((n) => n + 1); setSavedAt(false);
    const material = server.get(id)?.material ?? '';
    chain.current = chain.current.then(async () => {
      const r = await saveSheetAction({ stockCountId: data.count.id, edits: [{ stockCountLineId: id, ...edit }] });
      setSaving((n) => n - 1);
      if (r.ok) {
        adopt(r.data.rows);
        setErrors((cur) => { const { [id]: _gone, ...rest } = cur; return rest; });
        setSavedAt(true);
      } else {
        const msg = r.message.startsWith(`${material}: `) ? r.message.slice(material.length + 2) : r.message;
        setErrors((cur) => ({ ...cur, [id]: msg }));
        // put the box back to what is really saved
        const was = server.get(id);
        if (was) setLocal((cur) => ({ ...cur, [id]: { counted: text(was.countedQty), rate: text(was.unitRate), invoice: was.sourceInvoiceNo ?? '' } }));
      }
    });
  }, [data, server, adopt]);

  const setField = (id: string, patch: Partial<Local>) => setLocal((cur) => ({ ...cur, [id]: { ...(cur[id] as Local), ...patch } }));

  /** A box lost focus: save only what changed, and say so plainly if it is not a number. */
  function commit(r: CountLineRow, field: 'counted' | 'rate' | 'invoice') {
    const l = local[r.id] as Local;
    if (field === 'invoice') { if (l.invoice.trim() !== (r.sourceInvoiceNo ?? '')) save(r.id, { sourceInvoiceNo: l.invoice.trim() }); return; }
    const n = parse(l[field]);
    const was = field === 'counted' ? r.countedQty : r.unitRate;
    if (n === null) { setField(r.id, { [field]: text(was) }); return; } // an empty box keeps what is saved: a count is never wiped out
    if (Number.isNaN(n) || n < 0) { setErrors((cur) => ({ ...cur, [r.id]: 'Type a number.' })); return; }
    if (n === was) { setErrors((cur) => { const { [r.id]: _gone, ...rest } = cur; return rest; }); return; }
    save(r.id, field === 'counted' ? { countedQty: n } : { unitRate: n });
  }

  /** Enter moves down to the same box on the next row, scrolling it into view first (rows far away are not drawn). */
  function down(index: number, col: string) {
    const next = index + 1;
    if (next >= shown.length) return;
    virt.scrollToIndex(next);
    const tryFocus = (left: number) => {
      const el = scroller.current?.querySelector<HTMLElement>(`[data-row="${next}"][data-col="${col}"]`);
      if (el) el.focus(); else if (left > 0) requestAnimationFrame(() => tryFocus(left - 1));
    };
    requestAnimationFrame(() => tryFocus(10));
  }

  if (problem) return <p className="rounded-md border border-line bg-surface p-4" role="status">{problem}</p>;
  if (!data) return <p className="p-4 text-ink-soft" role="status">Opening the count sheet…</p>;

  const c = data.count;
  const gaps = [noQty > 0 ? `${noQty} material${noQty === 1 ? '' : 's'} not counted` : '', opening && noRate > 0 ? `${noRate} without a rate` : ''].filter(Boolean).join(' · ');
  const filters: { key: Filter; label: string; n: number; show: boolean }[] = [
    { key: 'all', label: 'All', n: all.length, show: true },
    { key: 'uncounted', label: 'Not counted yet', n: noQty, show: true },
    { key: 'different', label: 'Different', n: different, show: !opening },
    { key: 'rate', label: 'Missing rate', n: noRate, show: opening },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="count-sheet">
      <div className="shrink-0 space-y-3 border-b border-line p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-medium">{c.number} · {c.kind}</p>
          <p aria-live="polite" className="text-sm text-ink-soft" data-testid="save-state">{saving > 0 ? 'Saving…' : savedAt ? '✓ Saved' : ''}</p>
        </div>
        <div>
          <p className="text-lg font-semibold" data-testid="progress">{counted} of {all.length} counted</p>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-line" aria-hidden><div className="h-full bg-copper transition-[width]" style={{ width: `${all.length ? (counted / all.length) * 100 : 0}%` }} /></div>
        </div>
        {c.status === 'REJECTED' && c.rejectionNote && <p className="rounded-md border border-attention bg-copper-wash p-3"><span className="font-medium">The owner sent it back:</span> {c.rejectionNote}</p>}
        {!editable && <p className="flex items-start gap-2 rounded-md border border-line bg-paper p-3"><Lock aria-hidden className="mt-0.5 size-4 shrink-0" />It is with the owner, so it can&apos;t be changed now. If it needs a fix, the owner can send it back.</p>}
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
          {filters.filter((f) => f.show).map((f) => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}
              className={cn('inline-flex min-h-11 md:min-h-9 items-center rounded-full border px-3 text-base', filter === f.key ? 'border-copper bg-copper-wash font-medium' : 'border-line bg-surface hover:border-copper')}>
              {f.label} <span className="num ml-1.5 text-ink-soft">{f.n}</span>
            </button>
          ))}
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" role="table" aria-label="Count sheet" aria-rowcount={shown.length + 1}>
        {!compact && (
          <div role="row" className={cn('sticky top-0 z-10 grid gap-2 border-b border-line bg-paper px-4 py-2 text-sm font-medium text-ink-soft', opening ? 'grid-cols-[1fr_8rem_8rem_9rem]' : 'grid-cols-[1fr_6rem_8rem_6rem_9rem]')}>
            <span role="columnheader">Material</span>
            {!opening && <span role="columnheader" className="text-right">System</span>}
            <span role="columnheader">Counted</span>
            {opening ? <span role="columnheader">Rate ₹</span> : <span role="columnheader" className="text-right">Difference</span>}
            <span role="columnheader">{opening ? 'Invoice no. (optional)' : 'Reason'}</span>
          </div>
        )}
        {shown.length === 0 && <p className="p-4 text-ink-soft" role="status">{filter === 'all' ? 'There is nothing to count.' : 'Nothing here. Everything in this view is done.'}</p>}
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((v) => {
            const r = shown[v.index] as CountLineRow;
            const l = local[r.id] as Local;
            const unit = UOM_SHORT[r.unit] ?? r.unit;
            const err = errors[r.id];
            const typed = parse(l.counted);
            const diff = !opening && r.systemQty !== null && typed !== null && !Number.isNaN(typed) ? typed - r.systemQty : r.difference;
            const off = !editable;
            const countedBox = (
              <div className="relative">
                <input aria-label={`Counted, ${r.material}`} data-row={v.index} data-col="counted" inputMode="decimal" autoComplete="off" disabled={off} value={l.counted} aria-invalid={err ? true : undefined}
                  onChange={(e) => setField(r.id, { counted: e.target.value })} onBlur={() => commit(r, 'counted')}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(r, 'counted'); down(v.index, 'counted'); } }}
                  className={cn(cell, 'num pr-10 text-right')} />
                <span aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sm text-ink-soft">{unit}</span>
              </div>
            );
            const diffText = diff === null || diff === undefined ? '' : diff === 0 ? '0' : signed(diff);
            const diffBox = <span className={cn('num block text-right font-medium', diff && diff < 0 && 'text-alert', diff && diff > 0 && 'text-attention')} aria-label={`Difference, ${r.material}`}>{diffText && `${diffText} ${unit}`}</span>;
            const reasonBox = diff ? (
              <select aria-label={`Reason, ${r.material}`} data-row={v.index} data-col="reason" disabled={off} value={r.reason ?? 'UNEXPLAINED'} onChange={(e) => save(r.id, { reasonCode: e.target.value })} className={cell}>
                {REASONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            ) : null;
            const rateBox = (
              <div className="relative">
                <span aria-hidden className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-soft">₹</span>
                <input aria-label={`Rate, ${r.material}`} data-row={v.index} data-col="rate" inputMode="decimal" autoComplete="off" disabled={off} value={l.rate} placeholder={r.countedQty !== null && r.countedQty > 0 ? 'needed' : ''}
                  onChange={(e) => setField(r.id, { rate: e.target.value })} onBlur={() => commit(r, 'rate')}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(r, 'rate'); down(v.index, 'rate'); } }}
                  className={cn(cell, 'num pl-6 text-right', r.missing === 'rate' && 'border-attention')} />
              </div>
            );
            const invoiceBox = (
              <input aria-label={`Invoice number, ${r.material}`} data-row={v.index} data-col="invoice" autoComplete="off" disabled={off} value={l.invoice}
                onChange={(e) => setField(r.id, { invoice: e.target.value })} onBlur={() => commit(r, 'invoice')}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(r, 'invoice'); down(v.index, 'invoice'); } }} className={cell} />
            );
            const name = (
              <div className="min-w-0">
                <p className="truncate font-medium">{r.material}</p>
                {err && <p role="alert" className="flex items-start gap-1 text-sm text-alert"><CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />{err}</p>}
                {!err && r.missing && (r.countedQty !== null || r.unitRate !== null) && <p className="text-sm text-ink-soft">still needs {r.missing}</p>}
              </div>
            );
            return (
              <div key={r.id} role="row" aria-rowindex={v.index + 2} data-testid="count-row"
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: v.size, transform: `translateY(${v.start}px)` }}
                className="border-b border-line px-4 py-1.5">
                {compact ? (
                  <div className="space-y-1.5">
                    <div role="cell" className="flex items-baseline justify-between gap-2">{name}{!opening && <span className="num shrink-0 text-sm text-ink-soft">System {groupIndian(r.systemQty ?? 0)} {unit}</span>}</div>
                    <div className="grid grid-cols-2 gap-2">
                      <div role="cell">{countedBox}</div>
                      {opening ? <div role="cell">{rateBox}</div> : <div role="cell" className="self-center">{diffBox}</div>}
                    </div>
                    {opening ? <div role="cell">{invoiceBox}</div> : reasonBox && <div role="cell">{reasonBox}</div>}
                  </div>
                ) : (
                  <div className={cn('grid items-center gap-2', opening ? 'grid-cols-[1fr_8rem_8rem_9rem]' : 'grid-cols-[1fr_6rem_8rem_6rem_9rem]')}>
                    <div role="cell">{name}</div>
                    {!opening && <div role="cell" className="num text-right text-ink-soft">{groupIndian(r.systemQty ?? 0)} {unit}</div>}
                    <div role="cell">{countedBox}</div>
                    {opening ? <div role="cell">{rateBox}</div> : <div role="cell">{diffBox}</div>}
                    <div role="cell">{opening ? invoiceBox : reasonBox}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="shrink-0 border-t border-line p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onSend} disabled={!editable || gaps !== '' || saving > 0}>Send to owner</Button>
          {gaps !== '' && <p className="text-ink-soft" data-testid="send-reason">{gaps}</p>}
          {gaps === '' && editable && <p className="text-ink-soft">Everything is counted. Stock does not change until the owner approves.</p>}
        </div>
      </div>
    </div>
  );
}
