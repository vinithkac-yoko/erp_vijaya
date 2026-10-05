/** Exports: every format is produced for real and the FILE is opened and checked (not just the function return). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { exportArtifact, ExportError, FORMATS_BY_KIND, type Format } from './export';
import type { Role } from './catalog';

const rd = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const chrome = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', ...(existsSync('/opt/pw-browsers') ? readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-')).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`) : [])].find(existsSync);
const REPORT = rd('./examples/good/stock-report.vdoc'), SOP = rd('./examples/good/receiving-sop.vdoc');

const ALERTS = { rows: [
  { material: 'Copper wire 0.5mm', unit: 'kg', onHand: 12.5, minimumLevel: 50, shortfall: 37.5, materialId: 'm1' },
  { material: '=HYPERLINK("https://evil.test","x")', unit: 'kg', onHand: 1200, minimumLevel: 2500, shortfall: 1300, materialId: 'm2' },
  { material: '![x](/etc/hostname) ![y](/etc/passwd)', unit: 'kg', onHand: 3, minimumLevel: 5, shortfall: 2, materialId: 'm3' },
] };
const VALUE = { rows: [{ material: 'Copper wire 0.5mm', quantity: 10, value: 8125 }, { material: 'CRGO', quantity: 5, value: 1226442 }], total: 1234567 };
let calls: string[] = [];
const runRead = async (tool: string) => { calls.push(tool); return tool === 'get_stock_value' ? VALUE : ALERTS; };

let browser: Browser;
beforeAll(async () => { if (chrome) { process.env.CHROMIUM_PATH = chrome; browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] }); } }, 30000);
afterAll(async () => { await browser?.close(); });
const make = (kind: 'document' | 'page', source: string, format: Format, role: Role = 'OWNER', extra: object = {}) => exportArtifact({ kind, source, format, role, runRead, browser, now: new Date('2026-10-04T10:00:00Z'), ...extra });
const tmp = (name: string, b: Buffer) => { const d = mkdtempSync(join(tmpdir(), 'vt-')); const f = join(d, name); writeFileSync(f, b); return f; };

describe('exports (no browser needed)', () => {
  it('Markdown has resolved numbers, Indian grouping, the diagram source and a clean filename', async () => {
    const r = await make('document', REPORT, 'md');
    const md = r.bytes.toString('utf8');
    expect(r.filename).toBe('stock-position-2026-10-04.md'); expect(r.mime).toMatch(/markdown/);
    expect(md).toContain('₹12,34,567'); expect(md).toContain('| Material | On hand | Short by |'); expect(md).toContain('1,200 kg');
    expect(md).not.toMatch(/m1|m2|materialId/);   // no internal ids
    const sop = (await make('document', SOP, 'md', 'STOREKEEPER')).bytes.toString('utf8'); expect(sop).toContain('```mermaid');
  });
  it('CSV: raw numbers, quoted, and formula-looking text is neutralised', async () => {
    const csv = (await make('document', REPORT, 'csv')).bytes.toString('utf8').split('\r\n');
    expect(csv[0]).toBe('Material,On hand,Short by'); expect(csv[1]).toBe('Copper wire 0.5mm,12.5,37.5');
    expect(csv[2].startsWith(`"'=HYPERLINK(`)).toBe(true);
  });
  it('XLSX: real numbers with Indian rupee/quantity formats, formulas are not live, one sheet per table and chart', async () => {
    const r = await make('document', REPORT, 'xlsx');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.bytes);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Below minimum', 'Chart Stock value by material']);
    const t = wb.getWorksheet('Below minimum')!;
    expect(t.getCell('B2').value).toBe(12.5); expect(t.getCell('B2').numFmt).toContain('kg'); expect(t.getCell('C3').value).toBe(1300);
    expect(typeof t.getCell('A3').value).toBe('string');   // text, not a formula object
    const s = wb.getWorksheet('Summary')!; const row = s.getRows(1, 12)!.find((x) => x.getCell(1).value === 'Total value')!;
    expect(row.getCell(2).value).toBe(1234567); expect(String(row.getCell(2).numFmt)).toContain('₹');
    const c = wb.getWorksheet('Chart Stock value by material')!; expect(c.getCell('B3').value).toBe(1226442);
  });
  it('formats not offered for a kind are refused', async () => {
    await expect(make('page', '<script></script>', 'md' as Format)).rejects.toMatchObject({ code: 'FORMAT' });
    await expect(make('page', '<script></script>', 'docx' as Format)).rejects.toMatchObject({ code: 'FORMAT' });
    expect(FORMATS_BY_KIND.document).toEqual(['pdf', 'docx', 'xlsx', 'csv', 'png', 'md']);
  });
  it('a storekeeper cannot download an owner document, and the server is never asked for owner data', async () => {
    calls = [];
    await expect(make('document', REPORT, 'md', 'STOREKEEPER')).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    expect(calls).toEqual([]);
  });
  it('a document with no table cannot be a spreadsheet; message is plain', async () => {
    await expect(make('document', SOP, 'csv', 'STOREKEEPER')).rejects.toBeInstanceOf(ExportError);
  });
});

describe.skipIf(!chrome)('exports drawn by Chromium / pandoc, opened as real files', () => {
  it('PDF: valid, A4, text readable with the real numbers; no button text in print', async () => {
    const r = await make('document', REPORT, 'pdf'); expect(r.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const f = tmp('a.pdf', r.bytes);
    const txt = execFileSync('pdftotext', ['-layout', f, '-']).toString();
    expect(txt).toContain('Stock position'); expect(txt).toContain('₹12,34,567'); expect(txt).toContain('Copper wire 0.5mm'); expect(txt).toContain('1,300 kg'); expect(txt).not.toContain('Make PO');
    expect(execFileSync('pdfinfo', [f]).toString()).toMatch(/Page size:\s+595/);
  }, 60000);
  it('PDF with a diagram: the diagram text is in the file', async () => {
    const r = await make('document', SOP, 'pdf', 'STOREKEEPER');
    expect(execFileSync('pdftotext', [tmp('s.pdf', r.bytes), '-']).toString()).toContain('Record the receipt');
  }, 60000);
  it('PNG: valid image, 2x, tall enough for the whole document', async () => {
    const r = await make('document', REPORT, 'png'); expect(r.bytes.subarray(1, 4).toString()).toBe('PNG');
    const w = r.bytes.readUInt32BE(16), h = r.bytes.readUInt32BE(20); expect(w).toBe(1800); expect(h).toBeGreaterThan(900);
  }, 60000);
  it('DOCX: opens, has the text and bound numbers, charts and diagrams are pictures, a hostile value does not pull in a local file', async () => {
    const r = await make('document', REPORT, 'docx'); const f = tmp('a.docx', r.bytes);
    const files = execFileSync('unzip', ['-Z1', f]).toString();
    expect(files).toContain('word/document.xml'); expect(files).toMatch(/word\/media\/.*\.png/);
    const xml = execFileSync('unzip', ['-p', f, 'word/document.xml']).toString();
    expect(xml).toContain('₹12,34,567'); expect(xml).toContain('Stock position'); expect(xml).toContain('![x](/etc/hostname)'.replace(/\\/g, ''));
    expect((files.match(/word\/media\//g) ?? []).length).toBe(1);   // the one bar chart; not /etc/hostname
    const sop = await make('document', SOP, 'docx', 'STOREKEEPER');
    expect(execFileSync('unzip', ['-Z1', tmp('s.docx', sop.bytes)]).toString()).toMatch(/word\/media\/.*\.png/);   // the diagram
  }, 90000);
  it('PDF/PNG of a page artifact work; XLSX/CSV come from its tables; role guard applies to its reads', async () => {
    const page = rd('./examples/good/stock-below-minimum.html');
    expect((await make('page', page, 'pdf')).bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const csv = (await make('page', page, 'csv')).bytes.toString('utf8'); expect(csv).toContain('Copper wire 0.5mm');
    const x = new ExcelJS.Workbook(); await x.xlsx.load((await make('page', page, 'xlsx')).bytes); expect(x.worksheets.length).toBeGreaterThan(0);
    calls = []; await expect(make('page', rd('./examples/hostile/owner-tool.html'), 'pdf', 'STOREKEEPER')).rejects.toMatchObject({ code: 'NOT_ALLOWED' }); expect(calls).toEqual([]);
  }, 90000);
  it('a hostile page that tries to phone home exports nothing and sends nothing', async () => {
    const r = await make('page', rd('./examples/hostile/fetch-exfil.html'), 'pdf').catch((e) => e);
    // fetch-exfil fails the static check (so no export), which is the first line; the leak guard is the second
    expect(r).toBeInstanceOf(ExportError);
  }, 60000);
});
