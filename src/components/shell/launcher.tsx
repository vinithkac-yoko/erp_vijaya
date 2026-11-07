'use client';

import { ChevronDown, ClipboardList, FilePlus2, Briefcase, PackageMinus, PackagePlus, Undo2, type LucideIcon } from 'lucide-react';
import type { AskChip, FormButton, Launcher } from '@/lib/launcher/launcher';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/cn';

const ICONS: Record<string, LucideIcon> = {
  record_goods_receipt: PackagePlus,
  issue_material: PackageMinus,
  return_material: Undo2,
  start_stock_count: ClipboardList,
  create_purchase_order: FilePlus2,
  create_job: Briefcase,
};

const formClass =
  'inline-flex min-h-11 md:min-h-9 shrink-0 items-center gap-2 rounded-md border border-line bg-surface px-3 text-base font-semibold text-ink ' +
  'enabled:hover:bg-copper-wash disabled:cursor-not-allowed disabled:text-ink-faint';
const chipClass =
  'inline-flex min-h-11 md:min-h-9 shrink-0 items-center gap-2 rounded-full border border-line bg-copper-wash px-4 text-base text-ink ' +
  'enabled:hover:border-copper disabled:cursor-not-allowed disabled:text-ink-faint disabled:bg-surface';

function FormBtn({ b, enabled, onForm }: { b: FormButton; enabled: boolean; onForm: (tool: string) => void }) {
  const Icon = ICONS[b.tool] ?? FilePlus2;
  return (
    <button type="button" disabled={!enabled} data-tool={b.tool} aria-keyshortcuts={b.shortcut} className={formClass} onClick={() => onForm(b.tool)}
      title={enabled ? undefined : 'This button switches on in a later step.'}>
      <Icon aria-hidden className="size-5 shrink-0" />
      <span>{b.label}</span>
      <kbd className="num hidden text-xs font-normal text-ink-faint md:inline">{b.shortcut}</kbd>
    </button>
  );
}

function ChipBtn({ c, enabled, badge, onChip }: { c: AskChip; enabled: boolean; badge?: number; onChip: (label: string, ask: string) => void }) {
  return (
    <button type="button" disabled={!enabled} className={chipClass} onClick={() => onChip(c.label, c.prompt)}
      title={enabled ? undefined : 'This is switched off for now.'}>
      {c.label}
      {badge !== undefined && badge > 0 && <span className="num rounded-full bg-copper px-2 text-sm text-on-copper" aria-label={`${badge}`}>{badge}</span>}
    </button>
  );
}

function More({ forms, chips, formEnabled, chipEnabled, onForm, onChip }: {
  forms: FormButton[]; chips: AskChip[]; formEnabled: Record<string, boolean>; chipEnabled: Record<string, boolean>;
  onForm: (tool: string) => void; onChip: (label: string, ask: string) => void;
}) {
  if (forms.length + chips.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={cn(formClass, 'bg-transparent')}>
        More <ChevronDown aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {forms.map((f) => (
          <DropdownMenuItem key={f.tool} disabled={!formEnabled[f.tool]} onSelect={() => onForm(f.tool)}>
            <span className="flex-1">{f.label}</span><kbd className="num text-xs text-ink-faint">{f.shortcut}</kbd>
          </DropdownMenuItem>
        ))}
        {chips.map((c) => <DropdownMenuItem key={c.label} disabled={!chipEnabled[c.label]} onSelect={() => onChip(c.label, c.prompt)}>{c.label}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The buttons above the chat input. Built on the server from the role and the person's own use, never by the model.
 * Form buttons open the form directly (no model, so they work with the assistant off); chips ask the assistant.
 */
export function LauncherRow({ launcher, formEnabled, chipEnabled, badges, onForm, onChip }: {
  launcher: Launcher; formEnabled: Record<string, boolean>; chipEnabled: Record<string, boolean>; badges: { pendingApprovals: number; belowMinimum: number };
  onForm: (tool: string) => void; onChip: (label: string, ask: string) => void;
}) {
  const badge = (c: AskChip) => (c.badge === 'pendingApprovals' ? badges.pendingApprovals : c.badge === 'belowMinimum' ? badges.belowMinimum : undefined);
  return (
    <nav aria-label="Quick buttons" className="space-y-2">
      <div className="scroll-row -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
        {launcher.forms.map((b) => <FormBtn key={b.tool} b={b} enabled={!!formEnabled[b.tool]} onForm={onForm} />)}
        <More forms={launcher.moreForms} chips={[]} formEnabled={formEnabled} chipEnabled={chipEnabled} onForm={onForm} onChip={onChip} />
      </div>
      <div className="scroll-row -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
        {launcher.chips.map((c) => <ChipBtn key={c.label} c={c} enabled={!!chipEnabled[c.label]} badge={badge(c)} onChip={onChip} />)}
        <More forms={[]} chips={launcher.moreChips} formEnabled={formEnabled} chipEnabled={chipEnabled} onForm={onForm} onChip={onChip} />
      </div>
    </nav>
  );
}
