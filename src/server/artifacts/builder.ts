import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { ARTIFACT_OPENABLE_FORMS, TOOLS, type Role } from '@/lib/catalog';
import { checkArtifact, checkDoc, type Issue } from '@/lib/artifacts/check';
import VDoc from '@/lib/artifacts/host/vdoc.cjs';
import descriptions from '../../../prompts/tool-descriptions.json';
import type { Kind } from './store';

/**
 * The artifact builder (docs/ARTIFACTS.md §3, prompts/ARTIFACT_BUILDER.md): a SEPARATE model call that is given the
 * request and the tools this role may use, and never any row data. It writes; the server decides if it is good
 * (checkDoc / checkArtifact), sends the exact messages back for up to three repairs, and applies edits as patches that
 * must each match the current source exactly once.
 */
export const MAX_REPAIRS = 3;

export interface BuilderModel { client: Anthropic; model: string; effort: 'low' | 'medium' | 'high' }
export interface CheckReport { ok: boolean; issues: Issue[]; reads: string[]; forms: string[]; ownerOnly: string[]; usesMermaid: boolean }
export interface BuiltArtifact { kind: Kind; title: string; source: string; summary: string | null; report: CheckReport; usage: { input: number; output: number } }

export class BuilderError extends Error {
  constructor(public code: 'COULD_NOT_BUILD' | 'NO_ANSWER', message: string, public issues: Issue[] = []) { super(message); }
}

let cachedPrompt: string | undefined;
function promptTemplate(): string {
  if (cachedPrompt) return cachedPrompt;
  const doc = readFileSync(join(process.cwd(), 'prompts', 'ARTIFACT_BUILDER.md'), 'utf8');
  const a = doc.indexOf('<!-- BUILDER PROMPT START -->'), b = doc.indexOf('<!-- BUILDER PROMPT END -->');
  if (a < 0 || b < a) throw new Error('prompts/ARTIFACT_BUILDER.md has lost its BUILDER PROMPT START / END markers.');
  cachedPrompt = doc.slice(a + '<!-- BUILDER PROMPT START -->'.length, b).trim();
  return cachedPrompt;
}

const TEXT = (descriptions as { tools: Record<string, { description: string }> }).tools;
const firstSentence = (t: string) => (t.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? t).slice(0, 220);

/** The tools this role may use, for the builder: read tools with their inputs and the fields a table may show, and the forms a button may open. */
export function toolCatalogFor(role: Role): string {
  const reads = Object.values(TOOLS).filter((t) => t.kind === 'read' && !t.internal && t.roles.includes(role));
  const forms = Object.values(TOOLS).filter((t) => t.kind === 'write' && t.roles.includes(role) && ARTIFACT_OPENABLE_FORMS.has(t.name));
  const lines = ['READ TOOLS (for `reads:` in a document, and `vijaya.read` in a page):'];
  for (const t of reads) {
    const inputs = Object.keys(t.inputs).join(', ') || 'no inputs';
    lines.push(`- ${t.name} (${inputs}) — ${firstSentence(TEXT[t.name]?.description ?? '')}`);
    if (t.outputs?.length) lines.push(`    row fields to show: ${t.outputs.join(', ')}${t.bindOnly?.length ? `; only to feed a button: ${t.bindOnly.join(', ')}` : ''}`);
  }
  lines.push('', 'FORMS A BUTTON MAY OPEN (never with a rate):');
  for (const t of forms) lines.push(`- ${t.name} (${Object.keys(t.inputs).filter((k) => !/rate|price/i.test(k)).join(', ')})`);
  return lines.join('\n');
}

export function systemFor(opts: { role: Role; kind: Kind | 'choose'; current?: string; request: string }): string {
  return promptTemplate()
    .replaceAll('{{ROLE}}', opts.role === 'OWNER' ? 'the owner' : 'the storekeeper')
    .replaceAll('{{KIND}}', opts.kind)
    .replace('{{TOOL_CATALOG}}', () => toolCatalogFor(opts.role))
    .replace('{{CURRENT_CODE}}', () => (opts.current === undefined ? '' : `THE CURRENT SOURCE:\n\n\`\`\`\n${opts.current}\n\`\`\``))
    // The request is written by the assistant after it read rows, so it is untrusted too (builder rule 7).
    .replace('{{REQUEST}}', () => `<request>\n${opts.request}\n</request>`);
}

export const checkSource = (kind: Kind, source: string, role: Role): CheckReport =>
  kind === 'document' ? checkDoc(source, role) : { ...checkArtifact(source, role), usesMermaid: false };

const issueLines = (issues: Issue[]) => issues.map((i) => `${i.code}: ${i.message}${i.match ? ` (${i.match})` : ''}`).join('\n');

const NEW_TOOL: Anthropic.Tool = {
  name: 'return_artifact', description: 'Return the finished artifact.',
  input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['document', 'page'] }, title: { type: 'string' }, source: { type: 'string' } }, required: ['kind', 'title', 'source'] },
};
const EDIT_TOOL: Anthropic.Tool = {
  name: 'return_edit', description: 'Return the patches for the change, and one plain sentence saying what changed.',
  input_schema: { type: 'object', properties: { patches: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] } }, summary: { type: 'string' }, source: { type: 'string', description: 'Only after three failed patches: the whole new source.' } }, required: ['summary'] },
};

type Msg = Anthropic.MessageParam;

async function ask(m: BuilderModel, system: string, tool: Anthropic.Tool, messages: Msg[], usage: { input: number; output: number }): Promise<{ input: Record<string, unknown>; useId: string; content: Anthropic.ContentBlock[] }> {
  const stream = m.client.messages.stream({ model: m.model, max_tokens: 16_000, system, tools: [tool], tool_choice: { type: 'tool', name: tool.name }, messages });
  const reply = await stream.finalMessage();
  usage.input += (reply.usage.input_tokens ?? 0) + (reply.usage.cache_creation_input_tokens ?? 0) + Math.ceil((reply.usage.cache_read_input_tokens ?? 0) / 10);
  usage.output += reply.usage.output_tokens ?? 0;
  const use = reply.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === tool.name);
  if (!use) throw new BuilderError('NO_ANSWER', "I couldn't build that. Try asking a little differently.");
  return { input: use.input as Record<string, unknown>, useId: use.id, content: reply.content };
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** A new artifact. Up to three repairs, with the checker's own words; then the person is told it could not be built. */
export async function buildNew(m: BuilderModel, o: { role: Role; kind: Kind | undefined; request: string }): Promise<BuiltArtifact> {
  const system = systemFor({ role: o.role, kind: o.kind ?? 'choose', request: o.request });
  const messages: Msg[] = [{ role: 'user', content: 'Build it.' }];
  const usage = { input: 0, output: 0 };
  let last: Issue[] = [];
  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const r = await ask(m, system, NEW_TOOL, messages, usage);
    const kind: Kind = o.kind ?? (r.input.kind === 'page' ? 'page' : 'document');
    const source = text(r.input.source, 200_000);
    const report = checkSource(kind, source, o.role);
    if (report.ok) {
      const title = (kind === 'document' ? text(VDoc.parse(source).title, 120) : '') || text(r.input.title, 120) || 'Report';
      return { kind, title, source, summary: null, report, usage };
    }
    last = report.issues;
    messages.push({ role: 'assistant', content: r.content });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: r.useId, is_error: true, content: `Your ${kind} did not pass the checks. Fix every item and return the full JSON again.\n${issueLines(report.issues)}\nKeep everything else the same. Do not add numbers, ids or new tools to get around a check.` }] });
  }
  throw new BuilderError('COULD_NOT_BUILD', "I couldn't build that one safely.", last);
}

/** Applies patches: each `old` must appear exactly once. Returns the new source, or the first patch that does not match. */
export function applyPatches(current: string, patches: { old: string; new: string }[]): { ok: true; source: string } | { ok: false; old: string } {
  let src = current;
  for (const p of patches) {
    const first = src.indexOf(p.old);
    if (!p.old || first < 0 || src.indexOf(p.old, first + 1) >= 0) return { ok: false, old: p.old };
    src = src.slice(0, first) + p.new + src.slice(first + p.old.length);
  }
  return { ok: true, source: src };
}

const readsOf = (r: CheckReport) => new Set(r.reads);
const SAYS_REMOVED = /\b(remov|drop|delet|without|no longer|took out|left out|replac)/i;

/** A change to an existing artifact. The kind stays; the whole result is checked again; a read may not vanish without being said. */
export async function buildEdit(m: BuilderModel, o: { role: Role; kind: Kind; current: string; request: string }): Promise<BuiltArtifact> {
  const before = checkSource(o.kind, o.current, o.role);
  const system = systemFor({ role: o.role, kind: o.kind, current: o.current, request: o.request });
  const messages: Msg[] = [{ role: 'user', content: 'Make the change.' }];
  const usage = { input: 0, output: 0 };
  let last: Issue[] = [];
  let failures = 0;
  for (let attempt = 0; attempt <= MAX_REPAIRS + 1; attempt++) {
    const r = await ask(m, system, EDIT_TOOL, messages, usage);
    const summary = text(r.input.summary, 300) || 'Changed it.';
    const patches = Array.isArray(r.input.patches) ? (r.input.patches as { old?: unknown; new?: unknown }[]).map((p) => ({ old: text(p.old, 100_000), new: text(p.new, 100_000) })) : [];
    let problem: string | null = null;
    let source = '';
    if (patches.length) {
      const applied = applyPatches(o.current, patches);
      if (applied.ok) source = applied.source;
      else { failures++; problem = `PATCH_NO_MATCH: this text was not found exactly once in the current code: "${applied.old.slice(0, 120)}".\nCopy it exactly from the current source (or use a longer piece that appears only once) and return the patches again.`; }
    } else if (typeof r.input.source === 'string' && r.input.source) {
      if (failures >= MAX_REPAIRS) source = r.input.source.slice(0, 200_000);
      else problem = 'Return patches, not the whole source. Each `old` must appear exactly once in the current code.';
    } else problem = 'Return patches.';

    if (!problem) {
      const report = checkSource(o.kind, source, o.role);
      if (!report.ok) { last = report.issues; problem = `Your ${o.kind} did not pass the checks. Fix every item and return the patches again.\n${issueLines(report.issues)}\nKeep everything else the same. Do not add numbers, ids or new tools to get around a check.`; }
      else {
        const lost = [...readsOf(before)].filter((x) => !readsOf(report).has(x));
        if (lost.length && !SAYS_REMOVED.test(summary)) problem = `Your change dropped the read ${lost.join(', ')} without saying so. Keep it, or say in the summary what was removed (for example "Removed the scrap table.").`;
        else return { kind: o.kind, title: o.kind === 'document' ? text(VDoc.parse(source).title, 120) : '', source, summary, report, usage };
      }
    }
    messages.push({ role: 'assistant', content: r.content });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: r.useId, is_error: true, content: problem }] });
  }
  throw new BuilderError('COULD_NOT_BUILD', "I couldn't make that change safely.", last);
}
