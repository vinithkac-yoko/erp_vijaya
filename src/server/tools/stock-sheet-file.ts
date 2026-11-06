import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { SheetRow } from './stock-import';

/**
 * Reads the STOCK sheet of the store's workbook (or a CSV of that sheet) into rows. Only that sheet: the workbook's other sheets
 * (the rack-by-rack drawing, old dates, sleeves) are older copies and are never looked at.
 *
 * Columns are found from the header row: "Part No" and "Description" are named, and the kind (CORE, BOBBIN …) is the
 * unlabeled column just before "Part No". Quantity, unit, rack, shelf and remarks follow Description.
 */
export class SheetError extends Error {}

const SHEET = 'STOCK';

interface Cols { category: number; code: number; description: number; qty: number; uom: number; rack: number; shelf: number; remark: number }

function columnsOf(header: string[]): Cols {
  const at = (re: RegExp) => header.findIndex((h) => re.test(h.trim().toLowerCase()));
  const code = at(/^part\s*no/), description = at(/^description/);
  if (code < 1 || description < 0) throw new SheetError('This does not look like the stock sheet: the first row should have "Part No" and "Description".');
  const find = (re: RegExp, fallback: number) => { const i = at(re); return i >= 0 ? i : fallback; };
  return {
    category: code - 1, code, description,
    qty: find(/^qty/, description + 1), uom: find(/^uom/, description + 2), rack: find(/^rack/, description + 3), shelf: find(/^shelf/, description + 4), remark: find(/^remark/, description + 5),
  };
}

const rowsFrom = (grid: string[][]): SheetRow[] => {
  const cols = columnsOf(grid[0] ?? []);
  const out: SheetRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]!;
    const at = (c: number) => String(r[c] ?? '');
    out.push({ line: i + 1, category: at(cols.category), code: at(cols.code), description: at(cols.description), qty: at(cols.qty), uom: at(cols.uom), rack: at(cols.rack), shelf: at(cols.shelf), remark: at(cols.remark) });
  }
  return out;
};

/** A small CSV reader: quotes, doubled quotes, commas and new lines inside quotes. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out;
}

export async function readStockSheet(path: string): Promise<SheetRow[]> {
  const ext = extname(path).toLowerCase();
  if (ext === '.csv') return rowsFrom(parseCsv(await readFile(path, 'utf8')));
  if (ext === '.xls') throw new SheetError('This is an old-style Excel file (.xls). Open it in Excel, choose File, Save As, "Excel Workbook (.xlsx)", and use that file.');
  if (ext !== '.xlsx') throw new SheetError('Use an Excel file (.xlsx), or the STOCK sheet saved as a CSV.');
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.readFile(path); } catch { throw new SheetError("Couldn't open that file. Is it a real .xlsx file?"); }
  const ws = wb.worksheets.find((w) => w.name.trim().toUpperCase() === SHEET);
  if (!ws) throw new SheetError(`There is no sheet called ${SHEET} in this file (it has: ${wb.worksheets.map((w) => w.name.trim()).join(', ')}).`);
  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const cells: string[] = [];
    for (let c = 1; c <= Math.max(ws.columnCount, 9); c++) {
      const cell = row.getCell(c);
      const v = cell.value;
      cells.push(v === null || v === undefined ? '' : typeof v === 'object' && 'result' in v ? String(v.result ?? '') : cell.text);
    }
    grid[n - 1] = cells;
  });
  return rowsFrom(Array.from(grid, (r) => r ?? []));
}
