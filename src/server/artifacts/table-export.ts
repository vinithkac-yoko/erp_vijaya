import ExcelJS from 'exceljs';
import { TOOLS } from '@/lib/catalog';
import { ExportError, type ExportResult } from './export';

/**
 * A table in the chat as Excel or CSV (docs/ARTIFACTS.md §10). The server runs the read tool again as the DOWNLOADER, so the
 * file has the numbers as of now and only what that person may see. Columns are the tool's display fields (never an id or
 * a code); numbers stay numbers; no cell is a formula, and text starting = + - @ is neutralised.
 */
const MONEY = /(value|amount|total|worth|cost|price|rate|variance)/i;
const QTY = /(qty|quantity|onhand|shortfall|minimum|issued|returned|received|accepted|rejected|net|difference|shortage|collected|sold|short|balance)/i;
const ISO = /^\d{4}-\d{2}-\d{2}T/;
const INR = '[>=10000000]"₹"##\\,##\\,##\\,##0.00;[>=100000]"₹"##\\,##\\,##0.00;"₹"##,##0.00';
const neutralise = (v: unknown) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v);
const label = (k: string) => { const w = k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(); return w.charAt(0).toUpperCase() + w.slice(1); };
const idLike = (k: string) => /^(id|code)$/i.test(k) || /Id$/.test(k);
const csvCell = (v: unknown) => { const s = String(neutralise(v) ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const slug = (s: string) => (s || 'table').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'table';

export const MAX_TABLE_ROWS = 5000;

export function tableOf(tool: string, data: unknown): { columns: { key: string; label: string; kind: 'text' | 'num' | 'inr' | 'qty' | 'date' }[]; rows: Record<string, unknown>[] } {
  const rows = (data && typeof data === 'object' && Array.isArray((data as { rows?: unknown }).rows) ? (data as { rows: unknown[] }).rows : []).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
  if (!rows.length) throw new ExportError('NO_TABLE', 'There is nothing in that to put in a spreadsheet.');
  const declared = TOOLS[tool]?.outputs;
  const keys = (declared?.length ? declared.filter((k) => k in (rows[0] as object)) : Object.keys(rows[0] as object).filter((k) => !idLike(k))).filter((k) => !idLike(k));
  const columns = keys.map((key) => {
    const vals = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
    const nums = vals.length > 0 && vals.every((v) => typeof v === 'number');
    const dates = vals.length > 0 && vals.every((v) => typeof v === 'string' && ISO.test(v));
    const kind = dates ? 'date' : nums && MONEY.test(key) ? 'inr' : nums && QTY.test(key) && rows.some((r) => typeof r.unit === 'string') ? 'qty' : nums ? 'num' : 'text';
    return { key, label: label(key), kind } as const;
  });
  return { columns: columns.map((c) => ({ ...c })), rows: rows.slice(0, MAX_TABLE_ROWS) };
}

export async function tableFile(o: { tool: string; data: unknown; format: 'xlsx' | 'csv'; title?: string; now?: Date }): Promise<ExportResult> {
  const t = tableOf(o.tool, o.data);
  const when = o.now ?? new Date();
  const base = `${slug(o.title || o.tool.replace(/_/g, ' '))}-${when.toISOString().slice(0, 10)}`;
  const cell = (c: { kind: string }, v: unknown) => (v === null || v === undefined ? '' : c.kind === 'date' && typeof v === 'string' ? v.slice(0, 10) : v);
  if (o.format === 'csv') {
    const head = t.columns.map((c) => csvCell(c.label)).join(',');
    const body = t.rows.map((r) => t.columns.map((c) => csvCell(cell(c, r[c.key]))).join(','));
    return { filename: `${base}.csv`, mime: 'text/csv; charset=utf-8', bytes: Buffer.from([head, ...body].join('\r\n') + '\r\n', 'utf8') };
  }
  const wb = new ExcelJS.Workbook(); wb.created = when; wb.creator = 'Vijaya Stores';
  const ws = wb.addWorksheet((o.title || label(o.tool)).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Table');
  ws.addRow(t.columns.map((c) => c.label)).font = { bold: true };
  for (const r of t.rows) {
    const row = ws.addRow(t.columns.map((c) => {
      const v = r[c.key];
      if (v === null || v === undefined) return null;
      if (c.kind === 'date' && typeof v === 'string') return new Date(v);
      return typeof v === 'number' ? v : String(neutralise(String(v)));
    }));
    t.columns.forEach((c, i) => {
      const x = row.getCell(i + 1);
      const v = r[c.key];
      if (typeof v === 'number') x.numFmt = c.kind === 'inr' ? INR : c.kind === 'qty' && typeof r.unit === 'string' ? `#,##0.###" ${r.unit.replace(/"/g, '')}"` : '#,##0.###';
      else if (c.kind === 'date') x.numFmt = 'd mmm yyyy';
    });
  }
  ws.columns.forEach((c, i) => { c.width = Math.min(40, Math.max(10, (t.columns[i]?.label.length ?? 6) + 4)); });
  return { filename: `${base}.xlsx`, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: Buffer.from(await wb.xlsx.writeBuffer()) };
}
