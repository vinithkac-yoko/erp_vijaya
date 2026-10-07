'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { PickerOption } from '@/lib/forms';
import { pickerAction, pickerLabelAction } from '@/server/chat/actions';
import { cn } from '@/lib/cn';

const inputClass = 'block w-full min-h-12 rounded-md border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-faint';

/**
 * Type-ahead for a material, a business or a person. It finds names however they are spelt, shows a name and a small
 * second line, and keeps an id inside. A business is never free text (INTERFACE §6): you pick one that exists.
 */
export function Picker({ kind, value, onChange, partyRole, invalid, describedBy, id, autoFocus }: {
  kind: 'material' | 'party' | 'user'; value: string; onChange: (id: string) => void; partyRole?: 'SUPPLIER' | 'CUSTOMER';
  invalid?: boolean; describedBy?: string; id: string; autoFocus?: boolean;
}) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<PickerOption[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<PickerOption | null>(null);
  const seq = useRef(0);

  // A value the assistant filled in is an id: look up the name to show.
  useEffect(() => {
    if (!value) { setChosen(null); return; }
    if (chosen?.id === value) return;
    let alive = true;
    void pickerLabelAction({ kind, id: value }).then((o) => { if (alive && o) setChosen(o); });
    return () => { alive = false; };
  }, [value, kind, chosen?.id]);

  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    const t = setTimeout(() => {
      void pickerAction({ kind, query, role: partyRole }).then((r) => { if (mine === seq.current) { setOptions(r); setActive(0); } });
    }, 120);
    return () => clearTimeout(t);
  }, [query, open, kind, partyRole]);

  const choose = (o: PickerOption) => { setChosen(o); onChange(o.id); setOpen(false); setQuery(''); };

  if (value && chosen) {
    return (
      <div className="flex min-h-12 items-center justify-between gap-2 rounded-md border border-line bg-copper-wash px-3">
        <span id={id} className="min-w-0 truncate font-medium">{chosen.label}{chosen.secondary && <span className="ml-2 font-normal text-ink-soft">{chosen.secondary}</span>}</span>
        <button type="button" aria-label={`Change ${chosen.label}`} onClick={() => { onChange(''); setChosen(null); setOpen(true); }}
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-surface"><X aria-hidden className="size-4" /></button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input id={id} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-invalid={invalid || undefined} aria-describedby={describedBy}
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined} autoComplete="off" autoFocus={autoFocus}
        placeholder={kind === 'material' ? 'Start typing the material…' : kind === 'party' ? 'Start typing the name…' : 'Start typing the name…'}
        value={query} className={inputClass}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, options.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter' && open && options[active]) { e.preventDefault(); e.stopPropagation(); choose(options[active] as PickerOption); }
          else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
        }} />
      {open && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-line bg-surface p-1 shadow-md">
          {options.length === 0 && <li className="px-3 py-3 text-ink-soft">{query ? "Couldn't find that. Check the spelling." : 'Nothing to pick yet.'}</li>}
          {options.map((o, i) => (
            <li key={o.id} id={`${listId}-${i}`} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); choose(o); }}
              className={cn('flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md px-3', i === active && 'bg-copper-wash')}>
              <span className="font-medium">{o.label}</span><span className="text-sm text-ink-soft">{o.secondary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
