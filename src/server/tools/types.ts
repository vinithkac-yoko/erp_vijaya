import type { Prisma, PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import type { Role } from '@/lib/catalog';
import type { Card, Chip } from '@/lib/cards';
import type { FormDef } from '@/lib/forms';

export type { Role };
export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;

/** Who is calling. Built from the logged-in user on the server, never from a request body. */
export interface ToolSession { userId: string; name: string; role: Role }

/** How a write is stamped on the ledger and the audit log. */
export interface Actor {
  actorType: 'HUMAN' | 'AGENT';
  actorId: string;
  agentRunId?: string;
  toolName: string;
}

export interface ToolContext<D extends Db = Db> {
  session: ToolSession;
  db: D;
  actor: Actor;
  now: Date;
}

/** What a write tool says it did. The gateway writes it as one AuditEvent in the same transaction. */
export interface AuditDraft {
  entityType: string;
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'APPROVE' | 'REJECT' | 'REVERSE' | 'CANCEL' | 'SUBMIT' | 'CLOSE' | (string & {});
  reason?: string;
  before?: unknown;
  after?: unknown;
}

export interface WriteResult<O> { data: O; audit: AuditDraft }

interface Base<I extends z.ZodTypeAny> {
  name: string;
  /** REQUIRED on every tool. There is no default. */
  roles: Role[];
  input: I;
  /** Input keys the model must never see or fill in (a password). Removed from its schema and dropped from what it sends. */
  agentHidden?: string[];
}
export interface ReadTool<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> extends Base<I> {
  kind: 'read';
  handler: (ctx: ToolContext, input: z.output<I>) => Promise<O>;
  /** How the result shows in the chat: a table or card built on the server from the result. The model writes only a sentence. */
  view?: (data: O) => Card[];
}
export interface WriteTool<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> extends Base<I> {
  kind: 'write';
  /** Runs inside the gateway's transaction. Throw ToolError for business rules. */
  handler: (ctx: ToolContext<Tx>, input: z.output<I>) => Promise<WriteResult<O>>;
  /** The form as the person sees it. One definition per tool, the same wherever it opens from. */
  form: FormDef;
  /** The rubber stamp on the "Saved" card, e.g. "MATERIAL ADDED". Drawn by the server from the audit row. */
  stamp: string;
  /** The lines under the stamp, from the audit row's `after` (names and numbers people use, never ids). */
  describe: (after: Record<string, unknown>) => string[];
  /** After a successful save: facts from read-only checks (a shortage, a rate change) and chips for what to do next. */
  followUps?: (ctx: ToolContext, input: Record<string, unknown>, result: unknown) => Promise<FollowUpResult>;
}
export interface FollowUpResult { facts: string[]; chips: Chip[] }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ReadTool<any, any> | WriteTool<any, any>;

/** A tool as registered: the definition plus the model-facing text loaded from prompts/tool-descriptions.json. */
export type RegisteredTool = AnyTool & { description: string; inputDescriptions: Record<string, string> };

export type ToolOutcome<T = unknown> =
  | { ok: true; data: T; auditId?: string }
  | { ok: false; code: string; message: string; /** The form field the message belongs next to. */ field?: string; /** Names only (e.g. similar materials), never ids. */ details?: unknown };

export interface RunOptions {
  /** The id of the PendingAction the user just submitted. Required for every write. */
  confirmation?: string;
}
