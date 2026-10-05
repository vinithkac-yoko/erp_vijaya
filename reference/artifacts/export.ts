import { chromium, type Browser } from 'playwright-core';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { readToolsFor, type Role } from './catalog';
import { checkArtifact, checkDoc } from './artifact-check';
import { buildSandboxDoc } from './host/host.js';

/**
 * Downloads of artifacts: PDF, PNG, Word, Excel, CSV, Markdown. Everything is made on the SERVER, from the same
 * document text, with the numbers read again as the DOWNLOADER (the app's runRead = runTool with his session), so a
 * storekeeper cannot get an owner's numbers by downloading a shared artifact, and a file is never older than its
 * footer says. PDF/PNG are drawn by headless Chromium with every network request refused and any attempt recorded;
 * a leak fails the export. Word is made by pandoc from the resolved Markdown with charts/diagrams as images.
 */
export type Format = 'pdf' | 'png' | 'docx' | 'xlsx' | 'csv' | 'md';
export const FORMATS_BY_KIND: Record<'document' | 'page', Format[]> = { document: ['pdf', 'docx', 'xlsx', 'csv', 'png', 'md'], page: ['pdf', 'png', 'xlsx', 'csv'] };
const MIME: Record<Format, string> = {
  pdf: 'application/pdf', png: 'image/png', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export class ExportError extends Error { constructor(public code: string, message: string) { super(message); } }

const here = (p: string) => new URL(p, import.meta.url);
const rd = (p: string) => readFileSync(here(p), 'utf8');
const VDoc = createRequire(import.meta.url)('./host/vdoc.cjs');

export interface Assets { tokensCss: string; bootstrapSource: string; uiKitSource: string; vdocSource: string; docRenderSource: string; mermaidSource: string }
let cached: Assets | undefined;
export function loadAssets(): Assets {
  return cached ??= { tokensCss: rd('./host/tokens.css'), bootstrapSource: EXPORT_BOOTSTRAP, uiKitSource: rd('./host/uikit.js'), vdocSource: rd('./host/vdoc.cjs'), docRenderSource: rd('./host/docrender.js'),
    mermaidSource: rd('./node_modules/mermaid/dist/mermaid.min.js') };
}
/** Replaces host/bootstrap.js in the export page: reads go to the server function the exporter exposes (already role-guarded). */
const EXPORT_BOOTSTRAP = `(function(){var api={read:function(t,i){return window.__runRead(t,i||{});},openForm:function(){return Promise.reject(new Error('Not available'));},ready:Promise.resolve({user:{},theme:'light'})};
Object.defineProperty(window,'vijaya',{value:api,writable:false,configurable:false});})();`;

export interface ExportInput {
  kind: 'document' | 'page'; source: string; role: Role; format: Format; title?: string;
  runRead: (tool: string, input: unknown) => Promise<any>;       // the app's runTool for the DOWNLOADER
  browser?: Browser; table?: number; now?: Date; assets?: Assets;
}
export interface ExportResult { filename: string; mime: string; bytes: Buffer }

const slug = (s: string) => (s || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report';
const neutralise = (v: unknown) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v);   // CSV/Excel formula injection

export async function exportArtifact(inp: ExportInput): Promise<ExportResult> {
  if (!FORMATS_BY_KIND[inp.kind].includes(inp.format)) throw new ExportError('FORMAT', `A ${inp.kind} cannot be downloaded as ${inp.format.toUpperCase()}.`);
  const check = inp.kind === 'document' ? checkDoc(inp.source, inp.role) : checkArtifact(inp.source, inp.role);
  if (!check.ok) throw new ExportError('NOT_ALLOWED', 'This cannot be downloaded: ' + check.issues[0].message);
  const allowed = new Set(readToolsFor(inp.role));
  const guarded = async (tool: string, input: unknown) => { if (!allowed.has(tool)) throw new ExportError('NOT_ALLOWED', "This isn't available to you."); return inp.runRead(tool, input); };
  const when = inp.now ?? new Date();
  const base = slug(inp.title || (inp.kind === 'document' ? VDoc.parse(inp.source).title : '') || 'report') + '-' + when.toISOString().slice(0, 10);
  const done = (ext: string, bytes: Buffer): ExportResult => ({ filename: `${base}.${ext}`, mime: MIME[ext as Format], bytes });

  let model: any, data: Record<string, any> = {};
  if (inp.kind === 'document') {
    model = VDoc.parse(inp.source);
    await Promise.all(Object.entries(model.reads as Record<string, { tool: string; input: unknown }>).map(async ([n, r]) => { data[n] = await guarded(r.tool, r.input); }));
    if (inp.format === 'md') return done('md', Buffer.from(VDoc.toMarkdown(model, data), 'utf8'));
    if (inp.format === 'csv') return done('csv', Buffer.from(csvOf(model, data, inp.table ?? 0), 'utf8'));
    if (inp.format === 'xlsx') return done('xlsx', await xlsxOf(model, data, when));
  }

  // Everything else is drawn by the browser (pages: also CSV/XLSX from the tables on screen).
  const ownBrowser = !inp.browser;
  const browser = inp.browser ?? await chromium.launch({ executablePath: chromePath(), args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: inp.format === 'png' ? 2 : 1, serviceWorkers: 'block', acceptDownloads: false });
  const leaked: string[] = [];
  try {
    await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.startsWith('about:') || u.startsWith('data:') || u.startsWith('blob:')) return r.continue(); leaked.push(u); return r.abort(); });
    const page = await ctx.newPage();
    let inFlight = 0;
    await page.exposeFunction('__runRead', async (tool: string, input: unknown) => { inFlight++; try { return await guarded(tool, input); } finally { inFlight--; } });
    const a = inp.assets ?? loadAssets();
    const html = buildSandboxDoc({ kind: inp.kind, source: inp.kind === 'document' ? inp.source : undefined, html: inp.kind === 'page' ? inp.source : undefined, tokensCss: a.tokensCss,
      bootstrapSource: a.bootstrapSource, uiKitSource: a.uiKitSource, vdocSource: a.vdocSource, docRenderSource: a.docRenderSource, mermaidSource: a.mermaidSource, theme: 'light' });
    await page.emulateMedia({ media: 'print' });
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 });
    if (inp.kind === 'document') {
      await page.waitForFunction(() => document.documentElement.getAttribute('data-vdoc') !== null, null, { timeout: 25_000 });
      if (await page.evaluate(() => document.documentElement.getAttribute('data-vdoc')) === 'error') throw new ExportError('INVALID', 'This document has a problem and cannot be downloaded.');
    } else {
      await page.waitForTimeout(300);
      for (let i = 0; i < 50 && inFlight > 0; i++) await page.waitForTimeout(200);
      await page.waitForTimeout(400);
    }
    await page.evaluate(() => document.fonts?.ready);
    let out: ExportResult;
    if (inp.format === 'pdf') out = done('pdf', Buffer.from(await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } })));
    else if (inp.format === 'png') {
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.addStyleTag({ content: 'body{padding:24px !important;background:#fff !important}' });
      if (h > 16000) throw new ExportError('TOO_TALL', 'This is too long for one picture. Download it as a PDF instead.');
      out = done('png', Buffer.from(await page.screenshot({ fullPage: true })));
    } else if (inp.format === 'docx') {
      // charts and diagrams become pictures; everything else is resolved text
      const images: Record<number, string> = {}, files: Record<string, Buffer> = {};
      const boxes = await page.locator('#app .v-chart, #app .v-diagram').all();
      let bi = 0;
      for (let idx = 0; idx < model.blocks.length; idx++) {
        const t = model.blocks[idx].type;
        if (t !== 'vchart' && t !== 'mermaid') continue;
        const box = boxes[bi++]; if (!box) continue;
        const name = `img${idx}.png`; files[name] = Buffer.from(await box.screenshot()); images[idx] = name;
      }
      out = done('docx', pandocDocx(VDoc.toMarkdown(model, data, { images, escape: true }), files, model.title || ''));
    } else {   // page → csv / xlsx from the tables on screen
      const tables: string[][][] = await page.evaluate(() => [...document.querySelectorAll('#app table')].map((t) => [...t.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => (c as HTMLElement).innerText.trim()))));
      if (!tables.length) throw new ExportError('NO_TABLE', 'There is no table in this to download as a spreadsheet.');
      out = inp.format === 'csv' ? done('csv', Buffer.from(tables[Math.min(inp.table ?? 0, tables.length - 1)].map((r) => r.map((c) => csvCell(c)).join(',')).join('\r\n') + '\r\n', 'utf8'))
        : done('xlsx', await xlsxFromGrids(tables, when));
    }
    if (leaked.length) throw new ExportError('LEAK', 'Export blocked: the page tried to reach the network.');
    return out;
  } finally { await ctx.close(); if (ownBrowser) await browser.close(); }
}

function chromePath(): string {
  const c = process.env.CHROMIUM_PATH; if (c) return c;
  throw new ExportError('NO_BROWSER', 'Set CHROMIUM_PATH to the Chromium used for exports.');
}

// ---- CSV -------------------------------------------------------------------------------------------------------
const csvCell = (v: unknown) => { const s = String(neutralise(v) ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function tablesOf(model: any, data: Record<string, any>) {
  const out: { title: string; head: string[]; rows: { v: unknown; col: any; row: any }[][] }[] = [];
  let heading = '';
  for (const b of model.blocks) {
    if (b.type === 'h') heading = VDoc.inlineText(b.inlines, data);
    if (b.type === 'vtable') {
      const cols = b.spec.columns, rs = (data[b.spec.from]?.rows ?? []) as any[];
      out.push({ title: b.spec.title || heading || `Table ${out.length + 1}`, head: cols.map((c: any) => c.label || c.field), rows: rs.map((r) => cols.map((c: any) => ({ v: r[c.field], col: c, row: r }))) });
    } else if (b.type === 'table') {
      out.push({ title: heading || `Table ${out.length + 1}`, head: b.head.map((h: any) => VDoc.inlineText(h, data)), rows: b.rows.map((r: any[]) => r.map((c) => ({ v: VDoc.inlineText(c, data), col: {}, row: {} }))) });
    }
  }
  return out;
}
function csvOf(model: any, data: Record<string, any>, which: number): string {
  const t = tablesOf(model, data)[which];
  if (!t) throw new ExportError('NO_TABLE', 'There is no table in this to download as a spreadsheet.');
  const unitCol = (c: any) => (c.col?.format === 'qty' && c.col.unitField ? ' (' + c.row[c.col.unitField] + ')' : '');
  return [t.head.map(csvCell).join(','), ...t.rows.map((r) => r.map((c) => csvCell(c.v == null ? '' : c.v)).join(','))].join('\r\n') + '\r\n';
}

// ---- XLSX --------------------------------------------------------------------------------------------------------
const INR = '[>=10000000]"₹"##\\,##\\,##\\,##0.00;[>=100000]"₹"##\\,##\\,##0.00;"₹"##,##0.00';
async function xlsxOf(model: any, data: Record<string, any>, when: Date): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); wb.created = when; wb.creator = 'Vijaya Stores';
  const used = new Set<string>();
  const sheetName = (t: string) => { let n = t.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet', k = 1; while (used.has(n.toLowerCase())) n = n.slice(0, 27) + ' ' + ++k; used.add(n.toLowerCase()); return n; };
  const summary = wb.addWorksheet(sheetName('Summary'));
  summary.addRow([model.title || 'Report']).font = { bold: true, size: 14 };
  summary.addRow(['Made on', when.toISOString().slice(0, 10)]);
  for (const b of model.blocks) {
    if (b.type === 'vstats') for (const s of b.spec) { const v = VDoc.getPath(data, s.from + '.' + s.path); const r = summary.addRow([s.label, typeof v === 'number' ? v : VDoc.formatValue(v, s.format)]); if (typeof v === 'number') r.getCell(2).numFmt = s.format === 'inr' ? INR : '#,##0.###'; }
    else if (b.type === 'p' || b.type === 'h') summary.addRow([VDoc.inlineText(b.inlines, data)]);
  }
  summary.getColumn(1).width = 60; summary.getColumn(2).width = 20;
  for (const t of tablesOf(model, data)) {
    const ws = wb.addWorksheet(sheetName(t.title));
    ws.addRow(t.head).font = { bold: true };
    for (const r of t.rows) {
      const row = ws.addRow(r.map((c) => (c.v == null ? null : c.col.format === 'date' ? new Date(String(c.v)) : typeof c.v === 'number' ? c.v : String(c.v))));
      r.forEach((c, i) => {
        const cell = row.getCell(i + 1), f = c.col.format;
        if (typeof c.v === 'number') cell.numFmt = f === 'inr' ? INR : f === 'pct' || f === 'percent' ? '0.0"%"' : f === 'qty' && c.col.unitField && c.row[c.col.unitField] ? '#,##0.###" ' + String(c.row[c.col.unitField]).replace(/"/g, '') + '"' : '#,##0.###';
        else if (f === 'date' && c.v) cell.numFmt = 'd mmm yyyy';
      });
    }
    ws.columns.forEach((c, i) => { c.width = Math.min(40, Math.max(10, String(t.head[i] ?? '').length + 4)); });
  }
  for (const b of model.blocks) if (b.type === 'vchart') {
    const ws = wb.addWorksheet(sheetName('Chart ' + (b.spec.title || b.spec.y))); ws.addRow([b.spec.x, b.spec.y]).font = { bold: true };
    for (const r of data[b.spec.from]?.rows ?? []) { const row = ws.addRow([String(r[b.spec.x]), typeof r[b.spec.y] === 'number' ? r[b.spec.y] : null]); if (b.spec.format === 'inr') row.getCell(2).numFmt = INR; }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function xlsxFromGrids(grids: string[][][], when: Date): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); wb.created = when; wb.creator = 'Vijaya Stores';
  grids.forEach((g, i) => { const ws = wb.addWorksheet('Table ' + (i + 1)); g.forEach((r, k) => { const row = ws.addRow(r); if (k === 0) row.font = { bold: true }; }); });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---- DOCX --------------------------------------------------------------------------------------------------------
function pandocDocx(markdown: string, files: Record<string, Buffer>, title: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'vexp-'));
  try {
    writeFileSync(join(dir, 'in.md'), markdown, 'utf8');
    for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b);
    // --sandbox would also stop pandoc reading OUR chart pictures, so it is not used. Instead nothing from the database or
    // the author can become markup: toMarkdown({escape:true}) backslash-escapes it, and -gfm-raw_html drops raw HTML.
    // Pandoc runs in an empty temp dir that holds only our own PNGs, with no network access to the app.
    execFileSync('pandoc', ['-f', 'gfm-raw_html', '-t', 'docx', '--metadata', 'title=' + title, '-o', join(dir, 'out.docx'), join(dir, 'in.md')], { cwd: dir, timeout: 30_000 });
    return readFileSync(join(dir, 'out.docx'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
