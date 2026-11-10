import { TOOLS, ARTIFACT_OPENABLE_FORMS } from './catalog';

/**
 * Where a form's starting values came from. Only 'user' (typed in the form) is trusted as is.
 * Everything else is a suggestion: it is cleaned HERE, on the server, when the PendingAction is created —
 * not in the browser, because the browser is the thing an artifact or a steered model can talk to.
 */
export type Origin = 'user' | 'agent' | 'artifact' | 'launcher';

export interface PrefillResult { input: Record<string, unknown>; dropped: string[]; assisted: boolean }

const MAX_STRING = 200;
const MAX_LINES = 50;
const MAX_NUMBER = 1e9;

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function cleanScalar(v: unknown): unknown | undefined {
  if (typeof v === 'string') return v.length <= MAX_STRING ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') : undefined;
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= MAX_NUMBER ? v : undefined;
  if (typeof v === 'boolean') return v;
  return undefined; // null, objects, functions: not a value we pre-fill
}

/**
 * Keeps only fields that exist on the tool, drops every rate (a price is typed by a person, from the supplier's
 * invoice, never suggested by a model or a page), drops oversized or odd values, and caps the number of lines.
 * The launcher never passes anything. `assisted` tells the form to show the "assistant filled this in" badge.
 */
export function sanitizePrefill(tool: string, input: unknown, origin: Origin): PrefillResult {
  const meta = TOOLS[tool];
  if (!meta || meta.kind !== 'write') return { input: {}, dropped: ['*'], assisted: false };
  if (origin === 'artifact' && !ARTIFACT_OPENABLE_FORMS.has(tool)) return { input: {}, dropped: ['*'], assisted: false };
  if (origin === 'user') return { input: isPlain(input) ? { ...input } : {}, dropped: [], assisted: false };
  if (origin === 'launcher' || !isPlain(input)) return { input: {}, dropped: origin === 'launcher' && isPlain(input) ? Object.keys(input) : [], assisted: false };

  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const spec = meta.inputs[k];
    if (!spec || spec.rate) { dropped.push(k); continue; }
    if (k === 'lines' && 'lines' in meta.inputs) {
      if (!Array.isArray(v)) { dropped.push(k); continue; }
      const lines: Record<string, unknown>[] = [];
      v.slice(0, MAX_LINES).forEach((line, i) => {
        if (!isPlain(line)) { dropped.push(`lines[${i}]`); return; }
        const clean: Record<string, unknown> = {};
        for (const [lk, lv] of Object.entries(line)) {
          const ls = meta.inputs[`lines[].${lk}`];
          const c = cleanScalar(lv);
          if (!ls || ls.rate || c === undefined) dropped.push(`lines[${i}].${lk}`); else clean[lk] = c;
        }
        lines.push(clean);
      });
      if (v.length > MAX_LINES) dropped.push(`lines[${MAX_LINES}+]`);
      out.lines = lines;
      continue;
    }
    const c = cleanScalar(v);
    if (c === undefined) dropped.push(k); else out[k] = c;
  }
  return { input: out, dropped, assisted: Object.keys(out).length > 0 };
}
