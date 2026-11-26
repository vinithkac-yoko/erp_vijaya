import { TOOLS, type Role } from '../catalog';

/**
 * The button row above the chat input. Two kinds:
 *  - form buttons open a tool's form directly. No model involved, so they work when AGENT_ENABLED=false.
 *  - ask chips send a canned question to the assistant (reports, lists). Never a blank prompt.
 * The row is built from the role, never from the model, so it cannot be steered.
 */
export interface FormButton { kind: 'form'; tool: string; label: string; shortcut: string }
export interface AskChip { kind: 'ask'; label: string; prompt: string; badge?: 'pendingApprovals' | 'belowMinimum' }
export type LauncherItem = FormButton | AskChip;

const FORM_BUTTONS: (FormButton & { roles: Role[] })[] = [
  { kind: 'form', tool: 'record_goods_receipt', label: 'Receive stock',  shortcut: 'Alt+R', roles: ['STOREKEEPER', 'OWNER'] },
  { kind: 'form', tool: 'issue_material',       label: 'Issue to a job', shortcut: 'Alt+I', roles: ['STOREKEEPER', 'OWNER'] },
  { kind: 'form', tool: 'return_material',      label: 'Return',         shortcut: 'Alt+T', roles: ['STOREKEEPER', 'OWNER'] },
  { kind: 'form', tool: 'start_stock_count',    label: 'Count stock',    shortcut: 'Alt+C', roles: ['STOREKEEPER', 'OWNER'] },
  { kind: 'form', tool: 'create_purchase_order', label: 'New PO',        shortcut: 'Alt+P', roles: ['STOREKEEPER', 'OWNER'] },
  { kind: 'form', tool: 'create_job',           label: 'New job',        shortcut: 'Alt+J', roles: ['STOREKEEPER', 'OWNER'] },
];

const CHIPS: (AskChip & { roles: Role[] })[] = [
  { kind: 'ask', label: 'Waiting for me', prompt: 'What is waiting for my approval?', badge: 'pendingApprovals', roles: ['OWNER'] },
  { kind: 'ask', label: 'Low stock',      prompt: 'What is below its minimum level?', badge: 'belowMinimum', roles: ['STOREKEEPER', 'OWNER'] },
  { kind: 'ask', label: 'Open jobs',      prompt: 'Show the open jobs.', roles: ['STOREKEEPER', 'OWNER'] },
  { kind: 'ask', label: 'Stock today',    prompt: 'Show stock on hand.', roles: ['STOREKEEPER', 'OWNER'] },
  { kind: 'ask', label: 'Stock value',    prompt: 'Make a stock value report.', roles: ['OWNER'] },
];

/** Per-user use counts, e.g. {record_goods_receipt: 40, 'ask:Low stock': 12}. Built server-side from AuditEvent (openedFrom LAUNCHER) and chip taps. */
export type Usage = Record<string, number>;
export const MAX_FORM_BUTTONS = 4; // the rest sit behind "More"
export const MAX_CHIPS = 4;

const key = (i: LauncherItem) => (i.kind === 'form' ? i.tool : 'ask:' + i.label);

/** Stable sort by use count (desc); ties keep the default order, so new users see the defaults. */
function byUsage<T extends LauncherItem>(items: T[], usage: Usage): T[] {
  return items.map((it, n) => ({ it, n, u: Math.max(0, Math.floor(Number(usage[key(it)]) || 0)) }))
    .sort((a, b) => b.u - a.u || a.n - b.n).map((x) => x.it);
}

export interface Launcher { forms: FormButton[]; chips: AskChip[]; moreForms: FormButton[]; moreChips: AskChip[] }

/**
 * Top used first, per user. Role filtering happens BEFORE ordering, so usage can never surface a tool
 * the role may not use. "Continue count" is pinned first while a count is in progress.
 * Keyboard shortcuts stay with the tool, not the position.
 */
export function launcherFor(role: Role, opts: { countInProgress?: boolean; usage?: Usage } = {}): Launcher {
  const usage = opts.usage ?? {};
  let forms: FormButton[] = FORM_BUTTONS.filter((b) => b.roles.includes(role) && TOOLS[b.tool]?.roles.includes(role))
    .map(({ roles, ...b }) => (b.tool === 'start_stock_count' && opts.countInProgress ? { ...b, label: 'Continue count' } : b));
  let chips: AskChip[] = CHIPS.filter((c) => c.roles.includes(role)).map(({ roles, ...c }) => c);
  forms = byUsage(forms, usage);
  chips = byUsage(chips, usage);
  if (opts.countInProgress) forms = [...forms.filter((f) => f.tool === 'start_stock_count'), ...forms.filter((f) => f.tool !== 'start_stock_count')];
  return { forms: forms.slice(0, MAX_FORM_BUTTONS), moreForms: forms.slice(MAX_FORM_BUTTONS), chips: chips.slice(0, MAX_CHIPS), moreChips: chips.slice(MAX_CHIPS) };
}

/** Every form the role can open, in any position (shortcuts work even for buttons behind "More"). */
export function allFormsFor(role: Role): FormButton[] {
  const l = launcherFor(role);
  return [...l.forms, ...l.moreForms];
}

/** Keyboard: Alt+letter opens the form. Returns the tool, or undefined. */
export function shortcutTool(role: Role, key: string): string | undefined {
  const k = key.toUpperCase();
  return allFormsFor(role).find((i) => i.shortcut.toUpperCase() === 'ALT+' + k)?.tool;
}
