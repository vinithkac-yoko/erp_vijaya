/**
 * One table: every database constraint, every trigger code and every Prisma failure becomes `{ code, message }`.
 * The message is plain English, written here. A raw database message must never reach a screen or the model.
 * tests/errors.coverage.test.ts walks every constraint in the migrated database and every `RAISE` in the
 * migrations and fails when one has no entry.
 */
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

export interface MappedError { code: string; message: string; field?: string; details?: unknown }

/** Thrown by tool handlers for business rules. The message is already plain words. `field` puts it next to a form field. */
export class ToolError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown, public readonly field?: string) {
    super(message);
    this.name = 'ToolError';
  }
}

const e = (code: string, message: string): MappedError => ({ code, message });

const QTY = e('INVALID_QUANTITY', 'The quantity must be more than zero.');
const RULE = e('NOT_ALLOWED', "That isn't allowed. Nothing was saved.");
const NUMBER_TAKEN = e('NUMBER_TAKEN', 'That number was just used by someone else. Please try again.');
const TOO_BIG = e('INVALID_INPUT', 'That number is too big or has too many digits.');

/** CHECK constraints, by name. */
export const CHECKS: Record<string, MappedError> = {
  chk_movement_qty_positive: QTY,
  chk_movement_rate_positive: e('INVALID_RATE', "The rate can't be less than zero."),
  chk_balance_rate_positive: e('INVALID_RATE', "The rate can't be less than zero."),
  chk_grn_split: e('GRN_SPLIT_MISMATCH', 'Accepted and rejected must add up to what was received.'),
  chk_grn_qty_positive: e('INVALID_QUANTITY', "What was received must be more than zero. Accepted and rejected can't be less than zero."),
  chk_po_line_positive: e('INVALID_QUANTITY', "The quantity must be more than zero, and the rate can't be less than zero."),
  chk_bom_qty_positive: e('INVALID_QUANTITY', 'The quantity per piece must be more than zero.'),
  chk_job_qty_positive: e('INVALID_QUANTITY', 'The number of pieces must be more than zero.'),
  chk_scrap_sale_positive: e('INVALID_QUANTITY', "The quantity must be more than zero, and the rate can't be less than zero."),
  chk_material_minimum: e('INVALID_MINIMUM', "The minimum level can't be less than zero."),
  chk_standing_has_minimum: e('MINIMUM_REQUIRED', 'Material kept in stock needs a minimum level.'),
  chk_material_gst: e('INVALID_GST', 'GST must be between 0% and 100%.'),
  chk_party_has_type: e('PARTY_TYPE_REQUIRED', 'Choose supplier, customer or both.'),
  chk_party_gstin: e('INVALID_GSTIN', 'That GSTIN is not valid. It has 15 letters and numbers, like 33AAACS1234K1Z2.'),
  chk_user_email_lower: e('INVALID_INPUT', 'Please type the email in small letters.'),
  chk_series_number: e('INTERNAL', 'Something went wrong on our side. Nothing was saved.'),
  chk_count_difference: e('COUNT_DIFFERENCE_MISMATCH', 'The difference must be the counted quantity minus the system quantity.'),
  chk_count_rate_positive: e('RATE_REQUIRED', 'The rate must be more than zero. Take it from the last purchase invoice.'),
  chk_count_qty_not_negative: e('INVALID_QUANTITY', "A counted quantity can't be less than zero."),
  chk_count_reason: e('INVALID_REASON', 'Please choose one of the reasons on the list.'),
  chk_movement_direction: RULE,
  chk_issue_has_job: e('JOB_REQUIRED', 'Material is always given out against a job. Which job is it for?'),
  chk_adjustment_has_count: e('COUNT_NOT_APPROVED', 'Stock only changes from a count the owner has approved.'),
  chk_opening_has_count: e('COUNT_NOT_APPROVED', 'Stock only changes from a count the owner has approved.'),
  chk_receipt_has_grn: RULE,
  chk_sale_has_scrap_sale: RULE,
  chk_reversal_has_original: RULE,
};

/** Unique constraints and indexes, by their database name. */
export const UNIQUES: Record<string, MappedError> = {
  users_email_key: e('EMAIL_EXISTS', 'Someone already has that email.'),
  parties_nameKey_key: e('PARTY_EXISTS', 'That name is already saved.'),
  parties_gstin_key: e('PARTY_EXISTS', 'That GSTIN is already saved for another name.'),
  materials_nameKey_key: e('MATERIAL_EXISTS', 'That material is already in the list.'),
  stock_movements_reversalOfId_key: e('ALREADY_REVERSED', 'That entry has already been reversed.'),
  uq_movement_count_line: e('ALREADY_POSTED', 'That count line has already changed the stock.'),
  uq_movement_grn_line_type: e('ALREADY_POSTED', 'That receipt line has already been added to stock.'),
  // Prisma reports a violated unique index by its columns; these are the same two indexes under that spelling.
  stock_movements_stockCountLineId_key: e('ALREADY_POSTED', 'That count line has already changed the stock.'),
  stock_movements_grnLineId_type_key: e('ALREADY_POSTED', 'That receipt line has already been added to stock.'),
  customer_pos_customerId_number_key: e('CUSTOMER_PO_EXISTS', 'That customer already has a PO with that number.'),
  job_bom_lines_jobId_materialId_key: e('DUPLICATE_LINE', 'That material is on the list twice.'),
  stock_count_lines_stockCountId_materialId_key: e('DUPLICATE_LINE', 'That material is on the list twice.'),
  settings_key_key: e('SETTING_EXISTS', 'That setting already exists.'),
  artifact_versions_artifactId_n_key: NUMBER_TAKEN,
  number_series_docType_financialYear_key: NUMBER_TAKEN,
  artifacts_currentVersionId_key: RULE,
};

/** Rules for names that follow a pattern (primary keys, document numbers, internal codes, foreign keys). */
const PATTERNS: [RegExp, MappedError][] = [
  [/_number_key$/, NUMBER_TAKEN],
  [/_code_key$/, NUMBER_TAKEN],
  [/_pkey$/, e('INTERNAL', 'Something went wrong on our side. Nothing was saved.')],
  [/_fkey$/, e('NOT_FOUND', "Couldn't find that, or it is still being used. Check it and try again.")],
];

export const UNKNOWN_CONSTRAINT = e('INTERNAL', 'Something went wrong on our side. Nothing was saved.');

export function mapConstraint(name: string): MappedError | undefined {
  return CHECKS[name] ?? UNIQUES[name] ?? PATTERNS.find(([re]) => re.test(name))?.[1];
}

/** Codes that triggers raise as `CODE: …`. The text after the colon is for developers and is never shown. */
export const TRIGGER_CODES: Record<string, MappedError> = {
  COUNT_NOT_APPROVED: e('COUNT_NOT_APPROVED', 'Stock only changes from a count the owner has approved.'),
  COUNT_LINE_MISMATCH: RULE,
  OPENING_ONLY_FROM_OPENING_COUNT: e('NOT_ALLOWED', 'Opening stock can only come from the opening count.'),
  OPENING_COUNT_POSTS_OPENING: RULE,
  OPENING_RATE_MISSING: e('RATE_REQUIRED', 'Opening stock needs a rate from the last purchase invoice.'),
  OPENING_ALREADY_DONE: e('OPENING_ALREADY_DONE', 'The opening count has already been done.'),
  REVERSAL_MISMATCH: e('NOT_ALLOWED', 'A reversal must undo the same material and quantity, the other way round.'),
  COUNT_LOCKED: e('COUNT_LOCKED', "This count can't be changed now. It is with the owner, or already approved."),
  COUNT_SYSTEM_FROZEN: e('COUNT_LOCKED', 'The system quantity is fixed when counting starts. It cannot be changed.'),
  COUNT_INCOMPLETE: e('COUNT_INCOMPLETE', 'Some materials are not counted yet, or are missing a rate.'),
  NOT_PENDING: e('NOT_PENDING', 'That is not waiting for approval.'),
  LEDGER_APPEND_ONLY: e('LEDGER_APPEND_ONLY', 'Stock history is never changed or deleted. To fix a mistake, the owner adds a correcting entry.'),
  NO_BALANCE_ROW: e('NOT_FOUND', "Couldn't find that material. Check it and try again."),
};

// ── turning a thrown thing into { code, message } ───────────────────────────────────────────────

interface PgInfo { sqlstate?: string; message?: string; constraint?: string }

/** Prisma hands Postgres errors over as text in several shapes. Pull out the SQLSTATE, message and constraint name. */
function pgInfo(err: unknown): PgInfo {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
    const meta = err.meta as { code?: string; message?: string } | undefined;
    return { sqlstate: meta?.code, message: meta?.message };
  }
  const text = err instanceof Error ? err.message : String(err);
  const state = /code: \\?"([0-9A-Z]{5})\\?"/.exec(text)?.[1];
  const msg = /message: \\?"((?:[^"\\]|\\.)*)\\?"/.exec(text)?.[1];
  const constraint = /constraint \\?"([^"\\]+)\\?"/.exec(msg ?? text)?.[1];
  return { sqlstate: state, message: msg ?? text, constraint };
}

/** The first `CODE:` in the text that we know. (The text may start with Postgres's own "ERROR:".) */
const codeFromMessage = (m?: string) =>
  [...(m ?? '').matchAll(/(?:^|[\s"])([A-Z][A-Z_]{3,}):/g)].map((x) => x[1] as string).find((c) => c in TRIGGER_CODES);

function uniqueName(err: Prisma.PrismaClientKnownRequestError): string | undefined {
  const target = (err.meta as { target?: string[] | string; modelName?: string } | undefined)?.target;
  if (typeof target === 'string') return target;
  const model = (err.meta as { modelName?: string } | undefined)?.modelName;
  if (!Array.isArray(target) || !model) return undefined;
  const table = Prisma.dmmf.datamodel.models.find((m) => m.name === model)?.dbName ?? model;
  return `${table}_${target.join('_')}_key`;
}

/** The form field a validation message belongs to (the first path step of the first issue). */
export function fieldOf(err: ZodError): string | undefined {
  const first = err.issues[0]?.path[0];
  return typeof first === 'string' ? first : undefined;
}

export function mapError(err: unknown): MappedError {
  if (err instanceof ToolError) return { code: err.code, message: err.message, field: err.field, details: err.details };
  if (err instanceof ZodError) return { ...e('INVALID_INPUT', err.issues[0]?.message || 'Please check what you typed.'), field: fieldOf(err) };

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return (uniqueName(err) && mapConstraint(uniqueName(err) as string)) || e('ALREADY_EXISTS', 'That already exists.');
    if (err.code === 'P2003') return PATTERNS[3]?.[1] ?? UNKNOWN_CONSTRAINT;
    if (err.code === 'P2025') return e('NOT_FOUND', "Couldn't find that. Check it and try again.");
    if (err.code === 'P2034') return e('TRY_AGAIN', 'Two people changed this at the same moment. Please try again.');
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError || err instanceof Prisma.PrismaClientUnknownRequestError) {
    const { sqlstate, message, constraint } = pgInfo(err);
    if (sqlstate === '23514' || sqlstate === '23505' || sqlstate === '23503') {
      return (constraint && mapConstraint(constraint)) || UNKNOWN_CONSTRAINT;
    }
    if (sqlstate === '23502') return e('INVALID_INPUT', 'Something needed is missing. Please check the form.');
    if (sqlstate === '22003' || sqlstate === '22001' || sqlstate === '22P02') return TOO_BIG;
    if (sqlstate === '40001' || sqlstate === '40P01') return e('TRY_AGAIN', 'Two people changed this at the same moment. Please try again.');
    if (sqlstate === 'P0001') {
      const code = codeFromMessage(message);
      return (code && TRIGGER_CODES[code]) || UNKNOWN_CONSTRAINT;
    }
  }
  return UNKNOWN_CONSTRAINT;
}
