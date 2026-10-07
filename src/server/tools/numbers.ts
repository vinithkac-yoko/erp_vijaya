import { financialYear, formatDocNumber } from '@/lib/fy';
import type { Tx } from './types';

export const DOC_TYPES = ['PO', 'GRN', 'JOB', 'CNT', 'SCS'] as const;
export type DocType = (typeof DOC_TYPES)[number];

interface Row { lastNumber: number; prefix: string; padding: number }

/**
 * The next document number for this type and Indian financial year: `JOB-2627-0031`.
 * One atomic upsert: the row is locked until the caller's transaction ends, so two people at the same moment get
 * different numbers, and a rolled-back transaction leaves no gap.
 */
export async function nextNumber(tx: Tx, docType: DocType, date: Date = new Date()): Promise<string> {
  const fy = financialYear(date);
  const rows = await tx.$queryRaw<Row[]>`
    INSERT INTO number_series (id, "docType", prefix, "financialYear", "lastNumber", padding)
    VALUES (gen_random_uuid()::text, ${docType}, ${docType}, ${fy}, 1, 4)
    ON CONFLICT ("docType", "financialYear") DO UPDATE SET "lastNumber" = number_series."lastNumber" + 1
    RETURNING "lastNumber", prefix, padding`;
  const r = rows[0];
  if (!r) throw new Error('number series returned nothing');
  return formatDocNumber(r.prefix, fy, r.lastNumber, r.padding);
}

/** Internal codes (MAT-0001, PTY-0001). They never leave the server. */
export async function nextCode(tx: Tx, kind: 'MAT' | 'PTY'): Promise<string> {
  const rows = await tx.$queryRaw<Row[]>`
    INSERT INTO number_series (id, "docType", prefix, "financialYear", "lastNumber", padding)
    VALUES (gen_random_uuid()::text, ${kind}, ${kind}, 'ALL', 1, 4)
    ON CONFLICT ("docType", "financialYear") DO UPDATE SET "lastNumber" = number_series."lastNumber" + 1
    RETURNING "lastNumber", prefix, padding`;
  const r = rows[0];
  if (!r) throw new Error('number series returned nothing');
  return `${r.prefix}-${String(r.lastNumber).padStart(r.padding, '0')}`;
}
