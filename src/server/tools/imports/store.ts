import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { Prisma, type Upload } from '@prisma/client';
import { agentConfig } from '../../agent/config';
import { db } from '../../db';
import type { ToolSession } from '../types';
import { classify, KIND_WORDS, readLocal, safeName, UploadError, type Content, type FileKind, type Sheet } from './files';
import { estimateRead, recordSpend, rupees, spendStatus } from './spend';
import { estimateTokens, readWithModel, type ReadModel } from './vision';

/**
 * The owner's uploads (milestone 16): who may attach, how long a file is kept, what is kept of it. Only the owner may attach a
 * file or look at one; nothing here touches the business tables.
 */
export const RETENTION_DAYS = Number(process.env.UPLOAD_RETENTION_DAYS) > 0 ? Number(process.env.UPLOAD_RETENTION_DAYS) : 30;
export const UPLOADS_PER_HOUR = 40;
const DAY = 86_400_000;

export interface UploadInfo {
  id: string; filename: string; kind: FileKind; kindText: string; sizeBytes: number; createdAt: string; expiresAt: string; purged: boolean;
  readError: string | null; note: string | null;
  sheets: { name: string; rows: number; columns: number; hidden: boolean; truncated: boolean }[];
  textChars: number;
}

export const infoOf = (u: Upload): UploadInfo => {
  const c = (u.content ?? null) as Content | null;
  return {
    id: u.id, filename: u.filename, kind: u.kind, kindText: KIND_WORDS[u.kind], sizeBytes: u.sizeBytes, createdAt: u.createdAt.toISOString(), expiresAt: u.expiresAt.toISOString(), purged: !!u.purgedAt,
    readError: u.readError, note: c?.note ?? null,
    sheets: (c?.sheets ?? []).map((s) => ({ name: s.name, rows: s.rows.length, columns: s.rows[0]?.length ?? 0, hidden: !!s.hidden, truncated: !!s.truncated })), textChars: c?.text.length ?? 0,
  };
};

/** The model that reads PDFs and photos, or null when the assistant has no key here. */
export function readModel(): ReadModel | null {
  const c = agentConfig();
  if (!c.enabled || !c.apiKey) return null;
  return { client: new Anthropic({ apiKey: c.apiKey, baseURL: c.baseURL }), model: process.env.ANTHROPIC_READ_MODEL || c.model };
}

export const ownerOnly = (s: ToolSession) => { if (s.role !== 'OWNER') throw new UploadError('Only the owner can attach files.'); };

/** Files past their days are dropped (the row stays, as a record that there was one). */
export async function purgeExpired(now: Date): Promise<number> {
  const r = await db.upload.updateMany({ where: { expiresAt: { lte: now }, purgedAt: null }, data: { bytes: null, content: Prisma.DbNull, purgedAt: now } });
  return r.count;
}

export interface SaveDeps { now?: Date; model?: ReadModel | null }

/** Checks, keeps and reads one attached file. Throws UploadError (plain words) when it cannot be accepted. */
export async function saveUpload(session: ToolSession, input: { filename: string; bytes: Uint8Array; conversationId?: string | null }, deps: SaveDeps = {}): Promise<{ upload: UploadInfo; reused: boolean }> {
  ownerOnly(session);
  const now = deps.now ?? new Date();
  const filename = safeName(input.filename);
  const { kind, mime } = await classify(filename, input.bytes);
  await purgeExpired(now);
  if ((await db.upload.count({ where: { userId: session.userId, createdAt: { gt: new Date(now.getTime() - 3600_000) } } })) >= UPLOADS_PER_HOUR) throw new UploadError('That is a lot of files in an hour. Please wait a little and try again.');

  // the same file again is the same file: not kept twice and, for a PDF or photo, not paid for twice
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const same = await db.upload.findFirst({ where: { userId: session.userId, sha256, purgedAt: null, readError: null }, orderBy: { createdAt: 'desc' } });
  if (same) return { upload: infoOf(same), reused: true };

  const row = await db.upload.create({ data: { userId: session.userId, conversationId: input.conversationId ?? null, filename, mime, kind, sizeBytes: input.bytes.length, sha256, bytes: Buffer.from(input.bytes), createdAt: now, expiresAt: new Date(now.getTime() + RETENTION_DAYS * DAY) } });
  try {
    let content: Content;
    if (kind === 'PDF' || kind === 'IMAGE') {
      const model = deps.model === undefined ? readModel() : deps.model;
      if (!model) throw new UploadError("I can't read PDFs or photos right now (the assistant is not set up here). A sheet, CSV or Word file can still be read.");
      const status = await spendStatus(now);
      const guess = estimateRead(status.usdToInr, estimateTokens(kind, input.bytes));
      if (status.left <= 0 || guess > status.left) {
        throw new UploadError(`Reading PDFs and photos has reached this month's limit (${rupees(status.spent)} of ${rupees(status.cap)} used). It starts again next month, or you can raise the limit in Settings. Sheets, CSV and Word files still work.`);
      }
      const r = await readWithModel(model, kind, input.bytes, mime);
      await recordSpend({ userId: session.userId, uploadId: row.id, purpose: `read ${kind === 'PDF' ? 'a PDF' : 'a photo'}`, model: model.model, usage: r.usage, usdToInr: status.usdToInr, now });
      content = r.content;
    } else content = await readLocal(kind, input.bytes, filename);
    const done = await db.upload.update({ where: { id: row.id }, data: { content: content as unknown as Prisma.InputJsonValue } });
    return { upload: infoOf(done), reused: false };
  } catch (e) {
    const message = e instanceof UploadError ? e.message : "I couldn't read that file.";
    // a file that could not be read is not kept (nothing to look at, and it should not sit in the database)
    await db.upload.update({ where: { id: row.id }, data: { readError: message, bytes: null, purgedAt: now } });
    if (e instanceof UploadError) throw e;
    console.error('[uploads] read failed:', e instanceof Error ? e.message : e);
    throw new UploadError(message);
  }
}

/** One of the owner's uploads, with what was read from it. */
export async function getUpload(session: ToolSession, id: string): Promise<{ row: Upload; content: Content }> {
  ownerOnly(session);
  const row = await db.upload.findFirst({ where: { id, userId: session.userId } });
  if (!row) throw new UploadError("I can't find that file.");
  if (row.purgedAt || !row.content) throw new UploadError(`That file was removed after ${RETENTION_DAYS} days. Attach it again.`);
  return { row, content: row.content as unknown as Content };
}

/** The files a chat message says it attaches: all must be this owner's, readable, and not removed. */
export async function verifyUploads(session: ToolSession, ids: string[]): Promise<UploadInfo[]> {
  ownerOnly(session);
  if (ids.length === 0) return [];
  const rows = await db.upload.findMany({ where: { id: { in: ids }, userId: session.userId, purgedAt: null, readError: null } });
  if (rows.length !== new Set(ids).size) throw new UploadError("One of those files isn't available any more. Please attach it again.");
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).map(infoOf);
}

export async function listUploads(session: ToolSession, opts: { conversationId?: string; limit?: number } = {}): Promise<UploadInfo[]> {
  ownerOnly(session);
  const rows = await db.upload.findMany({ where: { userId: session.userId, purgedAt: null, readError: null, ...(opts.conversationId ? { conversationId: opts.conversationId } : {}) }, orderBy: { createdAt: 'desc' }, take: opts.limit ?? 20 });
  return rows.map(infoOf);
}

// ── looking at what was read ──────────────────────────────────────────────────────────────────────

const cellClip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);
export const colName = (i: number) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** The first rows of every sheet, enough to see what a sheet is. Cells are clipped. */
export function overview(content: Content, headRows = 8): { sheets: { name: string; rows: number; columns: number; hidden: boolean; truncated: boolean; head: { row: number; cells: string[] }[] }[]; text: string } {
  return {
    sheets: content.sheets.map((s) => ({ name: s.name, rows: s.rows.length, columns: s.rows[0]?.length ?? 0, hidden: !!s.hidden, truncated: !!s.truncated, head: s.rows.slice(0, headRows).map((r, i) => ({ row: i + 1, cells: r.map((c) => cellClip(c)) })) })),
    text: content.text.slice(0, 1500),
  };
}

export const ROWS_PER_LOOK = 150;
export function rowsOf(content: Content, sheet: string | undefined, from: number, count: number): { sheet: string; from: number; rows: { row: number; cells: string[] }[]; totalRows: number } | null {
  const s = pickSheet(content, sheet);
  if (!s) return null;
  const start = Math.max(1, from);
  const rows = s.rows.slice(start - 1, start - 1 + Math.min(count, ROWS_PER_LOOK)).map((r, i) => ({ row: start + i, cells: r.map((c) => cellClip(c, 80)) }));
  return { sheet: s.name, from: start, rows, totalRows: s.rows.length };
}

export function pickSheet(content: Content, name: string | undefined): Sheet | undefined {
  if (!name) return content.sheets.length === 1 ? content.sheets[0] : undefined;
  const key = name.trim().toLowerCase();
  return content.sheets.find((s) => s.name.toLowerCase() === key) ?? content.sheets.find((s) => s.name.toLowerCase().includes(key));
}

/** Rows that contain some words (every word, any order), across all sheets and the text. */
export function searchContent(content: Content, query: string, limit = 25): { sheet: string; row: number; cells: string[] }[] | { textLines: string[] } | { hits: { sheet: string; row: number; cells: string[] }[]; textLines: string[] } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { sheet: string; row: number; cells: string[] }[] = [];
  for (const s of content.sheets) {
    for (let i = 0; i < s.rows.length && hits.length < limit; i++) {
      const line = s.rows[i]!.join(' ').toLowerCase();
      if (words.every((w) => line.includes(w))) hits.push({ sheet: s.name, row: i + 1, cells: s.rows[i]!.map((c) => cellClip(c, 80)) });
    }
  }
  const textLines = content.text.split('\n').filter((l) => words.every((w) => l.toLowerCase().includes(w))).slice(0, 10).map((l) => cellClip(l, 200));
  return { hits, textLines };
}
