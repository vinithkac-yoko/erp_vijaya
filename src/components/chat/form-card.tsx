'use client';

import { useEffect, useRef, useState } from 'react';
import { CircleAlert, Sparkles } from 'lucide-react';
import type { ChatItem, Chip } from '@/lib/cards';
import type { FieldDef, FormDef } from '@/lib/forms';
import { cancelFormAction, submitFormAction, switchFormAction } from '@/server/chat/actions';
import { Button } from '@/components/ui/button';
import { Picker } from './picker';
import { LinesEditor, type BomLineValue } from './lines-editor';
import { GrnLinesEditor, PoLinesEditor, type GrnLineValue, type PoLineValue } from './purchasing-lines';

const box = 'block w-full min-h-12 rounded-md border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-faint aria-[invalid=true]:border-alert';

type Values = Record<string, unknown>;
interface Similar { message: string; matches: { name: string; city?: string | null; type?: string; unit?: string }[] }

const visible = (f: FieldDef, v: Values) => !f.showWhen || f.showWhen.in.includes(String(v[f.showWhen.field] ?? ''));

/** What goes to the server: only what is visible and filled; numbers as numbers; a ticked box as true. */
export function payload(form: FormDef, v: Values, notDuplicate: boolean, confirmUnusual = false): Values {
  const out: Values = {};
  for (const f of form.fields) {
    if (!visible(f, v)) continue;
    const x = v[f.name];
    if (f.type === 'checkbox') { if (x === true) out[f.name] = true; continue; }
    if (f.type === 'lines' || f.type === 'poLines' || f.type === 'grnLines') { if (Array.isArray(x) && x.length) out[f.name] = x; continue; }
    if (x === undefined || x === null || x === '') continue;
    out[f.name] = f.type === 'number' ? Number(String(x).replace(/,/g, '')) : typeof x === 'string' ? x.trim() : x;
  }
  if (notDuplicate) out.confirmNotDuplicate = true;
  if (confirmUnusual) out.confirmUnusual = true;
  return out;
}

export function FormCard({ pendingId, tool, form, values, assisted, info, state, conversationId, focusOnMount, onSaved, onClosed, onSwitched }: {
  pendingId: string; tool: string; form: FormDef; values: Values; assisted: boolean; info?: string[]; state: 'open' | 'saved' | 'closed'; conversationId: string | null;
  focusOnMount?: boolean; onSaved: (items: ChatItem[], chips: Chip[]) => void; onClosed: (items: ChatItem[]) => void; onSwitched?: (items: ChatItem[]) => void;
}) {
  const [v, setV] = useState<Values>(() => ({ ...values }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [similar, setSimilar] = useState<Similar | null>(null);
  const [notDuplicate, setNotDuplicate] = useState(false);
  /** "Is that right?": an unusual number is asked about once, and the answer is the person's. */
  const [confirm, setConfirm] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  /** The pieces in the job, for the live totals in a bill of materials. */
  const [jobQty, setJobQty] = useState<number | null>(typeof values.jobQuantity === 'number' ? values.jobQuantity : null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLFormElement>(null);

  useEffect(() => { if (focusOnMount) root.current?.querySelector<HTMLElement>('input, select, textarea')?.focus(); }, [focusOnMount]);

  if (state === 'saved') return <p className="rounded-md border border-line bg-surface px-4 py-3 text-ink-soft"><span className="font-medium text-confirm">✓ {form.title}</span> — saved</p>;
  if (state === 'closed') return <p className="rounded-md border border-line bg-surface px-4 py-3 text-ink-faint">{form.title} — not saved</p>;

  const set = (name: string, value: unknown) => { setV((p) => ({ ...p, [name]: value })); setErrors((p) => { const { [name]: _gone, ...rest } = p; return rest; }); setGeneral(null); };

  async function submit() {
    if (busy) return;
    setBusy(true); setGeneral(null);
    const r = await submitFormAction({ pendingId, values: payload(form, v, notDuplicate, confirmed) });
    setBusy(false);
    if (r.ok) { onSaved(r.items, r.chips); return; }
    if (r.code.startsWith('CONFIRM_')) { setConfirm(r.message); setConfirmed(false); return; }
    if (r.code.startsWith('SIMILAR_') && r.details) {
      setSimilar({ message: r.message, matches: (r.details as { matches: Similar['matches'] }).matches });
      setNotDuplicate(false);
      return;
    }
    const field = 'field' in r ? r.field : undefined;
    if (field && form.fields.some((f) => f.name === field)) {
      setErrors({ [field]: r.message });
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[name="${field}"], #f-${pendingId}-${field}`)?.focus());
    } else setGeneral(r.message);
  }

  /** "Send back" on an approval: this form closes and the other tool's form opens for the same thing. */
  async function switchTo() {
    if (busy) return;
    setBusy(true);
    const r = await switchFormAction({ pendingId, conversationId });
    setBusy(false);
    if (!r.ok) { setGeneral(r.message); return; }
    if (!r.sheet) onSwitched?.(r.items);
  }

  async function notNow() {
    const r = await cancelFormAction({ pendingId, conversationId });
    onClosed(r.items);
  }

  return (
    <form ref={root} noValidate aria-label={form.title}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      onKeyDown={(e) => {
        // Enter moves to the next box; Ctrl+Enter saves (INTERFACE §10). A picker handles its own Enter.
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); return; }
        const t = e.target as HTMLElement;
        if (e.key === 'Enter' && !e.defaultPrevented && (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox') && t.getAttribute('role') !== 'combobox') {
          e.preventDefault();
          const all = [...(root.current?.querySelectorAll<HTMLElement>('input:not([type=hidden]), select, textarea') ?? [])];
          all[all.indexOf(t) + 1]?.focus();
        }
      }}
      className="rounded-md border border-line border-l-4 border-l-copper bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-bold">{form.title}</h2>
        {assisted && <span className="inline-flex items-center gap-1 rounded-full bg-copper-wash px-3 py-1 text-sm font-medium text-copper-deep"><Sparkles aria-hidden className="size-4" />assistant filled this in — check it</span>}
      </div>
      {form.intro && <p className="mt-1 text-ink-soft">{form.intro}</p>}

      <div className="mt-4 space-y-4">
        {info && info.length > 0 && (
          <div className="rounded-md border border-line bg-paper p-3 text-base" data-testid="form-info">
            {info.map((line, i) => <p key={i} className={i === 0 ? 'font-medium' : 'text-ink-soft'}>{line}</p>)}
          </div>
        )}
        {form.fields.filter((f) => f.type !== 'hidden' && visible(f, v)).map((f) => {
          const id = `f-${pendingId}-${f.name}`;
          const err = errors[f.name];
          const hint = f.hint && !err ? `${id}-hint` : undefined;
          const described = [err ? `${id}-err` : undefined, hint].filter(Boolean).join(' ') || undefined;
          const common = { id, name: f.name, 'aria-invalid': err ? true : undefined, 'aria-describedby': described } as const;
          return (
            <div key={f.name}>
              {f.type === 'checkbox' ? (
                <label className="flex min-h-11 items-center gap-3 font-medium">
                  <input type="checkbox" {...common} checked={v[f.name] === true} onChange={(e) => set(f.name, e.target.checked)} className="size-5 accent-[var(--copper)]" />
                  {f.label}
                </label>
              ) : (
                <>
                  {f.type === 'lines' || f.type === 'poLines' || f.type === 'grnLines'
                    ? <p id={`${id}-label`} className="font-medium">{f.label}{f.required && <span aria-hidden className="text-alert"> *</span>}</p>
                    : <label htmlFor={id} className="font-medium">{f.label}{f.required && <span aria-hidden className="text-alert"> *</span>}</label>}
                  <div className="mt-1">
                    {f.type === 'select' ? (
                      <select {...common} value={String(v[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} className={box}>
                        {!f.options?.some((o) => o.value === '') && <option value="">Choose…</option>}
                        {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : f.type === 'lines' ? (
                      <LinesEditor id={id} value={(Array.isArray(v[f.name]) ? v[f.name] : []) as BomLineValue[]} onChange={(x) => setV((p) => ({ ...p, [f.name]: x }))} jobQuantity={jobQty} invalid={!!err} describedBy={described} />
                    ) : f.type === 'poLines' ? (
                      <PoLinesEditor id={id} value={(Array.isArray(v[f.name]) ? v[f.name] : []) as PoLineValue[]} onChange={(x) => setV((p) => ({ ...p, [f.name]: x }))} limit={typeof v.approvalLimit === 'number' ? v.approvalLimit : null} />
                    ) : f.type === 'grnLines' ? (
                      <GrnLinesEditor id={id} value={(Array.isArray(v[f.name]) ? v[f.name] : []) as GrnLineValue[]} onChange={(x) => setV((p) => ({ ...p, [f.name]: x }))} />
                    ) : f.type === 'material' || f.type === 'party' || f.type === 'user' || f.type === 'countLine' || f.type === 'customerPo' || f.type === 'job' || f.type === 'purchaseOrder' ? (
                      <Picker kind={f.type} id={id} value={String(v[f.name] ?? '')} onChange={(x) => set(f.name, x)} partyRole={f.partyRole} invalid={!!err} describedBy={described}
                        onOption={f.type === 'job' ? (o) => { if (o.quantity !== undefined) setJobQty(o.quantity); } : undefined}
                        forId={f.dependsOn ? String(v[f.dependsOn] ?? '') || undefined : undefined} filter={f.pickerFilter}
                        waitFor={f.dependsOn && !v[f.dependsOn] ? 'Pick the customer first' : undefined} />
                    ) : f.type === 'textarea' ? (
                      <textarea {...common} rows={3} value={String(v[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} className={box + ' py-3'} />
                    ) : (
                      <div className="relative">
                        <input {...common} type={f.type === 'number' ? 'text' : f.type} inputMode={f.type === 'number' ? 'decimal' : undefined} autoComplete={f.autoComplete ?? 'off'}
                          autoCapitalize="none" spellCheck={false} placeholder={f.placeholder} value={String(v[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)}
                          className={box + (f.unit ? ' pr-14' : '') + (f.type === 'number' ? ' num' : '')} />
                        {f.unit && <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-soft">{f.unit}</span>}
                      </div>
                    )}
                  </div>
                </>
              )}
              {f.suggestions && (
                <div className="mt-2 flex flex-wrap gap-2" aria-label="Quick picks">
                  {f.suggestions.map((q) => (
                    <button key={q} type="button" onClick={() => set(f.name, q)} className="inline-flex min-h-11 md:min-h-9 items-center rounded-full border border-line bg-copper-wash px-3 text-base hover:border-copper">{q}</button>
                  ))}
                </div>
              )}
              {err && <p id={`${id}-err`} role="alert" className="mt-1 flex items-start gap-1.5 text-alert"><CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />{err}</p>}
              {hint && <p id={hint} className="mt-1 text-sm text-ink-soft">{f.hint}</p>}
            </div>
          );
        })}
      </div>

      {similar && (
        <div role="alert" className="mt-4 rounded-md border border-attention bg-copper-wash p-3">
          <p className="font-medium">{similar.message}</p>
          <ul className="mt-1 list-disc pl-5 text-ink-soft">{similar.matches.map((m) => <li key={m.name}>{m.name}{m.city ? `, ${m.city}` : ''}{m.type ? ` — ${m.type}` : m.unit ? ` — ${m.unit}` : ''}</li>)}</ul>
          <label className="mt-2 flex min-h-11 items-center gap-3 font-medium">
            <input type="checkbox" checked={notDuplicate} onChange={(e) => setNotDuplicate(e.target.checked)} className="size-5 accent-[var(--copper)]" />
            No, mine is a different one
          </label>
          <p className="text-sm text-ink-soft">If it is the same one, press Not now and use the one in the list.</p>
        </div>
      )}
      {confirm && (
        <div role="alert" className="mt-4 rounded-md border border-attention bg-copper-wash p-3">
          <p className="font-medium">{confirm}</p>
          <label className="mt-2 flex min-h-11 items-center gap-3 font-medium">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="size-5 accent-[var(--copper)]" />
            Yes, that is right
          </label>
          <p className="text-sm text-ink-soft">If it is a slip, change the number above and press the button again.</p>
        </div>
      )}
      {general && <p role="alert" className="mt-4 flex items-start gap-1.5 text-alert"><CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0" />{general}</p>}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || (!!similar && !notDuplicate) || (!!confirm && !confirmed)}>{busy ? 'Saving…' : form.verb}</Button>
        {form.alt && <Button type="button" variant="secondary" onClick={() => void switchTo()} disabled={busy}>{form.alt.label}</Button>}
        <Button type="button" variant="ghost" onClick={() => void notNow()} disabled={busy}>Not now</Button>
        <span className="text-sm text-ink-faint">Ctrl+Enter saves</span>
      </div>
      <span hidden data-tool={tool} />
    </form>
  );
}
