/* eslint-disable @typescript-eslint/no-explicit-any */
import { TOOLS, PRINT_TEMPLATES, ARTIFACT_OPENABLE_FORMS, type Role } from '@/lib/catalog';
import VDoc from './host/vdoc.cjs';

/**
 * Static check on artifact code. The sandbox (host/host.js) is the real protection and holds even if this check
 * is skipped; this check exists to (1) fail early with a message the model can act on, (2) keep artifacts honest:
 * numbers come from read tools, never typed into the code, and (3) decide whether an artifact may be shared.
 */
export type IssueCode =
  | 'TOO_BIG' | 'FORBIDDEN' | 'NO_READ' | 'TOOL_NOT_LITERAL' | 'TOOL_UNKNOWN' | 'TOOL_NOT_ALLOWED'
  | 'TOOL_WRONG_KIND' | 'LITERAL_NUMBER' | 'RATE_IN_OPENFORM' | 'BAD_BRIDGE_USE' | 'DOC_INVALID' | 'HTML_IN_DOC' | 'LINK_IN_DOC';
export interface Issue { code: IssueCode; message: string; match?: string }

export const MAX_BYTES = 60_000;

const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /\bfetch\s*\(/, why: 'No network. Read data with vijaya.read(tool, input).' },
  { re: /\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bRTCPeerConnection\b|\bWebTransport\b/, why: 'No network.' },
  { re: /\bimport\s*\(|\bimportScripts\b|\bnew\s+(Shared)?Worker\b|\bserviceWorker\b/, why: 'No dynamic imports, workers or service workers. Put all code in the artifact.' },
  { re: /\bdocument\s*\.\s*cookie\b|\b(localStorage|sessionStorage|indexedDB|caches)\b/, why: 'No cookies or storage. Keep state in variables.' },
  { re: /\b(parent|top|opener|frames|globalThis\.parent)\s*(\.|\[)|\bwindow\s*\.\s*(parent|top|opener)\b/, why: 'Talk to the app only through the vijaya object.' },
  { re: /\b(window\s*\.\s*)?open\s*\(\s*['"`]/, why: 'Cannot open windows.' },
  { re: /\b(location|document\s*\.\s*location)\s*(\.|=|\[)/, why: 'Cannot navigate.' },
  { re: /\bpostMessage\b|\bMessageChannel\b|addEventListener\s*\(\s*['"]message['"]/, why: 'Do not use messaging directly. vijaya.read / vijaya.openForm are the only way out.' },
  { re: /<form\b/i, why: 'No forms in an artifact. To change data, call vijaya.openForm(tool, prefill): it opens the real form.' },
  { re: /\beval\s*\(|\bnew\s+Function\s*\(|\bsetTimeout\s*\(\s*['"`]|\bsetInterval\s*\(\s*['"`]/, why: 'No eval or string timers.' },
  { re: /<(iframe|object|embed|frame|base|meta|link)\b/i, why: 'No frames, plugins, meta, link or base tags.' },
  { re: /@import|url\s*\(\s*['"]?\s*(https?:|\/\/)/i, why: 'No external styles, fonts or images. Everything is inline.' },
  { re: /\b(innerHTML|outerHTML|insertAdjacentHTML)\b|\bdocument\s*\.\s*write(ln)?\b/, why: 'Build the page with vijaya.ui or textContent, not HTML strings.' },
  { re: /\bvijaya\s*\.\s*(write|run|exec|submit|propose|confirm)\b/, why: 'The bridge has only read() and openForm(). Nothing writes from an artifact.' },
  { re: /createElement(NS)?\s*\(\s*['"`](link|script|iframe|object|embed|meta|base|form|img)['"`]|\bDOMParser\b|createContextualFragment|\bRTC[A-Za-z]*\b/i, why: 'Build the page with vijaya.ui only: no link, script, frame, form, image or WebRTC elements.' },
  { re: /\bnew\s+Image\s*\(|\.\s*src\s*=|\.setAttribute\s*\(\s*['"]src['"]/, why: 'Cannot load images or scripts from code. The sandbox blocks it anyway.' },
  { re: /<img\b[^>]*\bsrc\s*=\s*["']?\s*(https?:|\/\/)/i, why: 'No external images.' },
];

const strip0 = (html: string) => html.replace(/<(?!script)[^>]*>/gi, ' ');
const strip = (html: string) => html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ');

export function checkArtifact(html: string, role: Role): { ok: boolean; issues: Issue[]; reads: string[]; forms: string[]; ownerOnly: string[] } {
  const issues: Issue[] = [];
  const add = (i: Issue) => issues.push(i);
  if (new TextEncoder().encode(html).length > MAX_BYTES) add({ code: 'TOO_BIG', message: `Keep artifacts under ${MAX_BYTES / 1000} KB.` });

  for (const { re, why } of FORBIDDEN) { const m = html.match(re); if (m) add({ code: 'FORBIDDEN', message: why, match: m[0] }); }
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=/gi)) add({ code: 'FORBIDDEN', message: 'No external scripts. Everything is inline.', match: m[0] });

  // No aliasing (const v = vijaya), no indexing (vijaya['read'], window['vijaya']).
  for (const m of html.matchAll(/[=,(:]\s*vijaya\b(?!\s*\.)|\bvijaya\s*\??\.?\s*\[|\[\s*['"`]vijaya['"`]\s*\]|\bvijaya\s*\.\s*(?!read\b|openForm\b|ui\b|fmt\b|ready\b|user\b|theme\b)[A-Za-z_$]+/g)) {
    if (/\bvijaya\s*\.\s*(write|run|exec|submit|propose|confirm)\b/.test(m[0])) continue;   // reported above
    add({ code: 'BAD_BRIDGE_USE', message: 'Use vijaya.read(...), vijaya.openForm(...), vijaya.ui.*, vijaya.fmt.* directly. Do not alias or index it.', match: m[0].trim() });
  }

  const reads: string[] = [], forms: string[] = [];
  const calls = [...html.matchAll(/\bvijaya\s*\.\s*(read|openForm)\s*\(\s*([^,)]*)/g)];
  for (const m of calls) {
    const method = m[1] ?? '', arg = (m[2] ?? '').trim();
    const lit = arg.match(/^(['"`])([a-z_]+)\1$/);
    if (!lit) { add({ code: 'TOOL_NOT_LITERAL', message: `vijaya.${method}() needs the tool name written out as a string, e.g. vijaya.${method}('list_jobs').`, match: arg }); continue; }
    const name = lit[2] ?? '', meta = TOOLS[name];
    if (!meta) { add({ code: 'TOOL_UNKNOWN', message: `There is no tool called ${name}.`, match: name }); continue; }
    if (!meta.roles.includes(role)) { add({ code: 'TOOL_NOT_ALLOWED', message: `${name} is not available to ${role.toLowerCase()}s.`, match: name }); continue; }
    if (method === 'read' && meta.kind !== 'read') { add({ code: 'TOOL_WRONG_KIND', message: `${name} writes data. vijaya.read() takes read tools only. To change data use vijaya.openForm('${name}').`, match: name }); continue; }
    if (method === 'openForm' && meta.kind !== 'write') { add({ code: 'TOOL_WRONG_KIND', message: `${name} is a read tool. Use vijaya.read('${name}').`, match: name }); continue; }
    if (method === 'openForm' && !ARTIFACT_OPENABLE_FORMS.has(name)) { add({ code: 'TOOL_NOT_ALLOWED', message: `An artifact cannot open the ${name} form.`, match: name }); continue; }
    (method === 'read' ? reads : forms).push(name);
  }
  if (!reads.length) add({ code: 'NO_READ', message: 'An artifact shows live data from vijaya.read(). Numbers are never typed into the code.' });

  // A rate is typed by a person from an invoice. An artifact must not suggest one.
  for (const m of html.matchAll(/vijaya\s*\.\s*openForm\s*\(\s*['"`][a-z_]+['"`]\s*,\s*(\{[^)]*\})/g)) {
    const arg = m[1] ?? '';
    if (/\b(rate|unitRate|price|amount)\b|['"]rate['"]/i.test(arg)) add({ code: 'RATE_IN_OPENFORM', message: 'Do not pre-fill a rate or price. The person types it from the invoice.', match: arg.slice(0, 60) });
  }

  // No business numbers typed into the page text or script strings.
  const text = strip(html).replace(/<[^>]*>/g, ' ');
  const strings = [...strip0(html).matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]).join(' | ');
  const lit = text.match(/(₹|Rs\.?|INR)\s*\d/) || html.match(/['"`][^'"`]*(₹|Rs\.?|INR)\s*\d[^'"`]*['"`]/) ||
              text.match(/\b\d[\d,]*(\.\d+)?\s*(kg|kgs|nos|pcs|mtr|mtrs|metres|meters|units)\b/i) ||
              strings.match(/(₹|Rs\.?|INR)\s*\d|\b\d[\d,]*(\.\d+)?\s*(kg|kgs|nos|pcs|mtr|mtrs|metres|meters|units)\b/i);
  if (lit) add({ code: 'LITERAL_NUMBER', message: 'Amounts and quantities must come from vijaya.read() and be formatted with vijaya.fmt, not typed into the page.', match: lit[0] });

  const ownerOnly = [...new Set([...reads, ...forms])].filter((n) => !TOOLS[n]?.roles.includes('STOREKEEPER'));
  return { ok: issues.length === 0, issues, reads: [...new Set(reads)], forms: [...new Set(forms)], ownerOnly };
}

const hasRate = (v: unknown): boolean => v != null && typeof v === 'object'
  ? Object.entries(v as object).some(([k, x]) => /^(rate|unitRate|price|amount)$/i.test(k) || hasRate(x)) : false;

/**
 * Static check on a DOCUMENT (VDoc text: reports, memos, SOPs, diagrams). A document has no model-written script, so
 * what is checked is: it parses, every read is a real read tool the role may use, every value is a binding (never
 * typed), buttons only open allowed forms with no rate, and no HTML or links. The renderer is ours; the sandbox still
 * wraps it, so this check is for honest numbers and a clear message to the model, not the safety wall.
 * A document MAY have no reads (an SOP, an explainer, a diagram of the process).
 */
export function checkDoc(source: string, role: Role): { ok: boolean; issues: Issue[]; reads: string[]; forms: string[]; ownerOnly: string[]; usesMermaid: boolean } {
  const issues: Issue[] = [];
  const add = (i: Issue) => issues.push(i);
  if (new TextEncoder().encode(source).length > MAX_BYTES) add({ code: 'TOO_BIG', message: `Keep documents under ${MAX_BYTES / 1000} KB.` });
  const model = VDoc.parse(source);
  for (const m of VDoc.validate(model) as string[]) add({ code: 'DOC_INVALID', message: m });

  const reads: string[] = [], forms: string[] = [];
  for (const [name, r] of Object.entries(model.reads) as [string, { tool: string; input: unknown }][]) {
    const meta = TOOLS[r.tool];
    if (!meta) { add({ code: 'TOOL_UNKNOWN', message: `There is no tool called ${r.tool} (read "${name}").`, match: r.tool }); continue; }
    if (!meta.roles.includes(role)) { add({ code: 'TOOL_NOT_ALLOWED', message: `${r.tool} is not available to ${role.toLowerCase()}s.`, match: r.tool }); continue; }
    if (meta.kind !== 'read') { add({ code: 'TOOL_WRONG_KIND', message: `${r.tool} writes data. A document header lists read tools only.`, match: r.tool }); continue; }
    reads.push(r.tool);
  }
  for (const b of model.blocks as any[]) {
    if (b.type !== 'vtable') continue;
    for (const rb of (b.spec.rowButtons || []) as { tool: string; prefill?: unknown }[]) {
      const meta = TOOLS[rb.tool];
      if (!meta) { add({ code: 'TOOL_UNKNOWN', message: `There is no tool called ${rb.tool}.`, match: rb.tool }); continue; }
      if (!meta.roles.includes(role)) { add({ code: 'TOOL_NOT_ALLOWED', message: `${rb.tool} is not available to ${role.toLowerCase()}s.`, match: rb.tool }); continue; }
      if (meta.kind !== 'write') { add({ code: 'TOOL_WRONG_KIND', message: `${rb.tool} is a read tool. A row button opens a form.`, match: rb.tool }); continue; }
      if (!ARTIFACT_OPENABLE_FORMS.has(rb.tool)) { add({ code: 'TOOL_NOT_ALLOWED', message: `A document cannot open the ${rb.tool} form.`, match: rb.tool }); continue; }
      if (hasRate(rb.prefill)) add({ code: 'RATE_IN_OPENFORM', message: 'Do not pre-fill a rate or price. The person types it from the invoice.' });
      forms.push(rb.tool);
    }
  }

  // Text the author typed (not bindings): no business numbers, no HTML, no links.
  const typed: string[] = [];
  for (const n of VDoc.allInlines(model) as any[]) if (n.t !== 'bind') typed.push(n.v);
  for (const b of model.blocks as any[]) { if (b.type === 'mermaid') typed.push(b.text); if (b.type === 'vstats') for (const x of b.spec || []) typed.push(String(x.label || '')); if (b.type === 'vtable') for (const c of b.spec.columns || []) typed.push(String(c.label || '')); }
  const text = typed.join(' | ');
  const lit = text.match(/(₹|Rs\.?|INR)\s*\d/) || text.match(/\b\d[\d,]*(\.\d+)?\s*(kg|kgs|nos|pcs|mtr|mtrs|metres|meters|units)\b/i);
  if (lit) add({ code: 'LITERAL_NUMBER', message: 'Amounts and quantities must be bindings like {{value.total|inr}}, not typed into the document.', match: lit[0] });
  const prose = (model.blocks as any[]).filter((b) => b.type !== 'code' && b.type !== 'mermaid');
  const proseText = [...(VDoc.allInlines({ blocks: prose }) as any[])].map((n) => (n.t === 'bind' ? '' : n.v)).join(' ');
  if (/<\/?[a-z][^>]*>/i.test(proseText)) add({ code: 'HTML_IN_DOC', message: 'No HTML in a document. Use plain Markdown.' });
  if (/https?:\/\/|\]\(|\bwww\./i.test(proseText + ' ' + (model.blocks as any[]).filter((b) => b.type === 'mermaid').map((b) => b.text).join(' '))) add({ code: 'LINK_IN_DOC', message: 'No links in a document.' });

  const ownerOnly = [...new Set([...reads, ...forms])].filter((n) => !TOOLS[n]?.roles.includes('STOREKEEPER'));
  return { ok: issues.length === 0, issues, reads: [...new Set(reads)], forms: [...new Set(forms)], ownerOnly, usesMermaid: (model.blocks as any[]).some((b) => b.type === 'mermaid') };
}

export function canShareDoc(source: string): { ok: boolean; reason?: string } {
  const r = checkDoc(source, 'OWNER');
  if (!r.ok) return { ok: false, reason: 'This document has problems; fix them first.' };
  if (r.ownerOnly.length) return { ok: false, reason: `It uses owner-only data (${r.ownerOnly.join(', ')}). Make a version without it to share.` };
  return { ok: true };
}

/** An owner may share a frozen version with the storekeeper only if it never touches an owner-only tool. */
export function canShare(html: string): { ok: boolean; reason?: string } {
  const r = checkArtifact(html, 'OWNER');
  if (!r.ok) return { ok: false, reason: 'This artifact has problems; fix them first.' };
  if (r.ownerOnly.length) return { ok: false, reason: `It uses owner-only data (${r.ownerOnly.join(', ')}). Make a version without it to share.` };
  return { ok: true };
}

export function checkPrintRequest(template: string, role: Role): { ok: boolean; message?: string } {
  const t = PRINT_TEMPLATES[template];
  if (!t) return { ok: false, message: `There is no printout called ${template}.` };
  if (!t.roles.includes(role)) return { ok: false, message: 'That printout is not available to you.' };
  return { ok: true };
}
