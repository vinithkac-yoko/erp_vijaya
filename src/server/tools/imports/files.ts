import JSZip from 'jszip';
import { parseCsv } from '../stock-sheet-file';

/**
 * Checking and reading what the owner attaches (milestone 16). Everything here is pure: bytes in, a plain description of the
 * file out. A file is never trusted by its name: the kind comes from what the bytes are. A file is never run, opened with a
 * program that runs macros, or followed anywhere: a sheet is read cell by cell, a Word file is read as text from its XML, a PDF
 * or a photo is handed (once) to the model to read. What is read is DATA for the assistant to look at, never instructions.
 */
export type FileKind = 'XLSX' | 'CSV' | 'DOCX' | 'TXT' | 'PDF' | 'IMAGE';

export class UploadError extends Error {}

export interface Sheet { name: string; rows: string[][]; hidden?: boolean; /** The sheet had more rows than are kept. */ truncated?: boolean }
export interface Content { sheets: Sheet[]; text: string; /** For a PDF or photo: what it says about itself (a page count, "photo"). */ note?: string }

export const LIMITS = {
  sheetBytes: 10 * 1024 * 1024, pdfBytes: 20 * 1024 * 1024, imageBytes: 8 * 1024 * 1024,
  rows: 20_000, columns: 60, cell: 300, text: 200_000, zipEntries: 3_000, zipUnpacked: 100 * 1024 * 1024,
};
export const KIND_WORDS: Record<FileKind, string> = { XLSX: 'Excel sheet', CSV: 'CSV sheet', DOCX: 'Word file', TXT: 'text file', PDF: 'PDF', IMAGE: 'photo' };
const MIME: Record<FileKind, string> = {
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', CSV: 'text/csv', TXT: 'text/plain',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', PDF: 'application/pdf', IMAGE: 'image/*',
};

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const hasNul = (b: Uint8Array) => b.subarray(0, 8192).includes(0);
const IMAGE_TYPES: { ext: string[]; mime: string; test: (b: Uint8Array) => boolean }[] = [
  { ext: ['.png'], mime: 'image/png', test: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { ext: ['.jpg', '.jpeg'], mime: 'image/jpeg', test: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  { ext: ['.gif'], mime: 'image/gif', test: (b) => starts(b, [0x47, 0x49, 0x46, 0x38]) },
  { ext: ['.webp'], mime: 'image/webp', test: (b) => starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8) },
];

const extOf = (name: string) => { const m = /\.[A-Za-z0-9]{1,8}$/.exec(name.trim()); return m ? m[0].toLowerCase() : ''; };

/** A file name safe to show and to keep: no folders, no control characters, not too long. */
export function safeName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().slice(0, 120);
  return cleaned || 'file';
}

/** What kind of file this is, from its bytes (the name only helps to tell a CSV from a text file). Throws UploadError in plain words. */
export async function classify(filename: string, bytes: Uint8Array): Promise<{ kind: FileKind; mime: string }> {
  const ext = extOf(filename);
  if (bytes.length === 0) throw new UploadError('That file is empty.');
  if (ext === '.xls') throw new UploadError('That is an old-style Excel file (.xls). Open it in Excel, choose File, Save As, "Excel Workbook (.xlsx)", and attach that one.');
  if (ext === '.doc') throw new UploadError('That is an old-style Word file (.doc). Open it in Word, choose Save As, "Word Document (.docx)", and attach that one.');
  if (ext === '.heic' || ext === '.heif') throw new UploadError('Photos in the iPhone HEIC format cannot be read. Take the photo again as JPEG, or send a screenshot of it.');

  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.docx') {
    if (ext === '.xlsm') throw new UploadError('Files with macros (.xlsm) are not accepted. Save the sheet as .xlsx (without macros) and attach that.');
    if (bytes.length > LIMITS.sheetBytes) throw new UploadError(`That file is too big (the most is ${LIMITS.sheetBytes / 1024 / 1024} MB).`);
    if (!starts(bytes, [0x50, 0x4b, 0x03, 0x04])) throw new UploadError(`That is not a real ${ext === '.docx' ? '.docx' : '.xlsx'} file.`);
    const zip = await openZip(bytes);
    if (ext === '.xlsx') {
      if (!zip.file('xl/workbook.xml')) throw new UploadError('That is not a real .xlsx file.');
      return { kind: 'XLSX', mime: MIME.XLSX };
    }
    if (!zip.file('word/document.xml')) throw new UploadError('That is not a real .docx file.');
    return { kind: 'DOCX', mime: MIME.DOCX };
  }
  if (ext === '.pdf') {
    if (bytes.length > LIMITS.pdfBytes) throw new UploadError(`That PDF is too big (the most is ${LIMITS.pdfBytes / 1024 / 1024} MB).`);
    if (!Buffer.from(bytes.subarray(0, 1024)).toString('latin1').includes('%PDF-')) throw new UploadError('That is not a real PDF file.');
    return { kind: 'PDF', mime: MIME.PDF };
  }
  const img = IMAGE_TYPES.find((t) => t.ext.includes(ext));
  if (img) {
    if (bytes.length > LIMITS.imageBytes) throw new UploadError(`That photo is too big (the most is ${LIMITS.imageBytes / 1024 / 1024} MB).`);
    if (!img.test(bytes)) throw new UploadError('That is not a real picture file.');
    return { kind: 'IMAGE', mime: img.mime };
  }
  if (ext === '.csv' || ext === '.txt' || ext === '.tsv') {
    if (bytes.length > LIMITS.sheetBytes) throw new UploadError(`That file is too big (the most is ${LIMITS.sheetBytes / 1024 / 1024} MB).`);
    if (hasNul(bytes) || starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x25, 0x50, 0x44, 0x46])) throw new UploadError(`That is not a plain ${ext === '.txt' ? 'text' : 'CSV'} file.`);
    return { kind: ext === '.txt' ? 'TXT' : 'CSV', mime: MIME[ext === '.txt' ? 'TXT' : 'CSV'] };
  }
  throw new UploadError('I can read Excel (.xlsx), CSV, Word (.docx), text, PDF and photos (JPEG, PNG). That file is none of those.');
}

/** Opens a zip and refuses one that is a bomb (thousands of entries, or a huge size once unpacked). */
async function openZip(bytes: Uint8Array): Promise<JSZip> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new UploadError("Couldn't open that file. Is it a real Office file?"); }
  const entries = Object.values(zip.files);
  if (entries.length > LIMITS.zipEntries) throw new UploadError('That file has too many parts inside to be a normal one.');
  let total = 0;
  for (const e of entries) total += (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  if (total > LIMITS.zipUnpacked) throw new UploadError('That file would be far too big once opened.');
  return zip;
}

const clip = (s: string) => (s.length > LIMITS.cell ? `${s.slice(0, LIMITS.cell)}…` : s);

/** Trims empty trailing columns and rows; row numbers (index + 1) stay the real ones. */
function tidy(grid: string[][]): { rows: string[][]; truncated: boolean } {
  let rows = grid.map((r) => r ?? []);
  const truncated = rows.length > LIMITS.rows;
  if (truncated) rows = rows.slice(0, LIMITS.rows);
  while (rows.length && rows[rows.length - 1]!.every((c) => c === '')) rows.pop();
  const width = Math.min(LIMITS.columns, rows.reduce((w, r) => { let n = r.length; while (n > 0 && r[n - 1] === '') n--; return Math.max(w, n); }, 0));
  return { rows: rows.map((r) => Array.from({ length: width }, (_, i) => clip(r[i] ?? ''))), truncated };
}

function cellText(v: unknown, text: () => string): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(Number(v.toFixed(8)));
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('error' in (v as object)) return '';
    if ('result' in (v as object)) { const r = (v as { result: unknown }).result; return r === null || r === undefined ? '' : cellText(r, text); }
    return text();
  }
  return String(v).replace(/\s+/g, ' ').trim();
}

async function readXlsx(bytes: Uint8Array): Promise<Content> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer); } catch { throw new UploadError("Couldn't open that file. Is it a real .xlsx file?"); }
  const sheets: Sheet[] = [];
  for (const ws of wb.worksheets) {
    const grid: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      if (n > LIMITS.rows + 1) return;
      const cells: string[] = [];
      const width = Math.min(ws.columnCount, LIMITS.columns);
      for (let c = 1; c <= width; c++) {
        const cell = row.getCell(c);
        // the other cells of a merged block repeat the first one's text; only the first keeps it
        cells.push(cell.type === ExcelJS.ValueType.Merge ? '' : cellText(cell.value, () => { try { return cell.text.replace(/\s+/g, ' ').trim(); } catch { return ''; } }));
      }
      grid[n - 1] = cells;
    });
    const t = tidy(Array.from(grid, (r) => r ?? []));
    sheets.push({ name: ws.name.trim().slice(0, 80) || `Sheet ${sheets.length + 1}`, rows: t.rows, ...(ws.state !== 'visible' ? { hidden: true } : {}), ...(t.truncated ? { truncated: true } : {}) });
  }
  if (sheets.length === 0) throw new UploadError('That workbook has no sheets.');
  return { sheets, text: '' };
}

function decode(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}

/** The separator a sheet saved as text uses, from its first lines. */
function delimiterOf(text: string): string {
  const head = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  const score = (d: string) => { const counts = head.map((l) => l.split(d).length - 1); return counts.length && counts.every((c) => c > 0) ? Math.min(...counts) : 0; };
  return [',', '\t', ';', '|'].map((d) => ({ d, s: score(d) })).sort((a, b) => b.s - a.s)[0]!.s > 0 ? [',', '\t', ';', '|'].map((d) => ({ d, s: score(d) })).sort((a, b) => b.s - a.s)[0]!.d : ',';
}

function readCsv(bytes: Uint8Array, name: string): Content {
  const text = decode(bytes);
  const t = tidy(parseCsv(text, delimiterOf(text)).map((r) => r.map((c) => c.replace(/\s+/g, ' ').trim())));
  return { sheets: [{ name: name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Sheet', rows: t.rows, ...(t.truncated ? { truncated: true } : {}) }], text: '' };
}

function readTxt(bytes: Uint8Array, name: string): Content {
  const text = decode(bytes).replace(/\r\n?/g, '\n').slice(0, LIMITS.text);
  const lines = text.split('\n').filter((l) => l.trim());
  // lines with tabs in them are a table pasted as text
  const tabbed = lines.length >= 2 && lines.filter((l) => l.includes('\t')).length / lines.length >= 0.8;
  const sheets: Sheet[] = tabbed ? [{ name: name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Table', rows: tidy(lines.map((l) => l.split('\t').map((c) => c.trim()))).rows }] : [];
  return { sheets, text };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
  if (e[0] === '#') { const n = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENTITIES[e.toLowerCase()] ?? '';
});
/** The words in one run of Word XML (a paragraph or a table cell): text, tabs and line breaks. Only the text inside <w:t> is kept. */
const wordsOf = (xml: string) => {
  const parts: string[] = [];
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<\/w:p>/g)) {
    if (m[1] !== undefined) parts.push(unescapeXml(m[1]));
    else if (m[0].startsWith('<w:tab')) parts.push('\t');
    else parts.push('\n');
  }
  return parts.join('').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
};

async function readDocx(bytes: Uint8Array): Promise<Content> {
  const zip = await openZip(bytes);
  const xml = await zip.file('word/document.xml')!.async('string');
  const body = /<w:body[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const sheets: Sheet[] = [];
  const out: string[] = [];
  const block = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  for (let m = block.exec(body); m; m = block.exec(body)) {
    if (m[0].startsWith('<w:tbl')) {
      const rows = [...m[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((tr) => [...tr[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((tc) => wordsOf(tc[0]).replace(/\s*\n\s*/g, ' ')));
      const t = tidy(rows);
      sheets.push({ name: `Table ${sheets.length + 1}`, rows: t.rows, ...(t.truncated ? { truncated: true } : {}) });
      out.push(`[Table ${sheets.length}: ${t.rows.length} rows]`);
    } else {
      const words = wordsOf(m[0]);
      if (words) out.push(words);
    }
  }
  return { sheets, text: out.join('\n').slice(0, LIMITS.text) };
}

/** Reads a file that needs no model (a sheet, CSV, Word or text file). PDFs and photos are read by vision.ts. */
export async function readLocal(kind: FileKind, bytes: Uint8Array, filename: string): Promise<Content> {
  if (kind === 'XLSX') return readXlsx(bytes);
  if (kind === 'CSV') return readCsv(bytes, filename);
  if (kind === 'TXT') return readTxt(bytes, filename);
  if (kind === 'DOCX') return readDocx(bytes);
  throw new UploadError('That kind of file is read by the model.');
}
