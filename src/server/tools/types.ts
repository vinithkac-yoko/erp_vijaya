import type { Prisma, PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import type { Role } from '@/lib/catalog';

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
}
export interface ReadTool<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> extends Base<I> {
  kind: 'read';
  handler: (ctx: ToolContext, input: z.output<I>) => Promise<O>;
}
export interface WriteTool<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> extends Base<I> {
  kind: 'write';
  /** Runs inside the gateway's transaction. Throw ToolError for business rules. */
  handler: (ctx: ToolContext<Tx>, input: z.output<I>) => Promise<WriteResult<O>>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ReadTool<any, any> | WriteTool<any, any>;

/** A tool as registered: the definition plus the model-facing text loaded from prompts/tool-descriptions.json. */
export type RegisteredTool = AnyTool & { description: string; inputDescriptions: Record<string, string> };

export type ToolOutcome<T = unknown> =
  | { ok: true; data: T; auditId?: string }
  | { ok: false; code: string; message: string };

export interface RunOptions {
  /** The id of the PendingAction the user just submitted. Required for every write. */
  confirmation?: string;
}
