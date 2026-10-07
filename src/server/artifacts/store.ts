import type { Prisma } from '@prisma/client';
import { ToolError } from '../errors';
import type { Db, ToolSession } from '../tools/types';

/**
 * Artifacts, their versions and who they are shared with (docs/ARTIFACTS.md §3.2, §5, §6, §8). These tables hold no
 * business data (the numbers are never stored: only the source that reads them), so this module may use the database
 * directly. Business data still only comes through the Tool Gateway.
 */
export const MAX_VERSIONS = 100;
export const BUILDS_PER_HOUR = 20;
export type Kind = 'document' | 'page';
export const toKind = (k: 'PAGE' | 'DOCUMENT'): Kind => (k === 'DOCUMENT' ? 'document' : 'page');
export const fromKind = (k: Kind) => (k === 'document' ? ('DOCUMENT' as const) : ('PAGE' as const));

export interface ArtifactView {
  artifactId: string; title: string; kind: Kind; version: number; versions: number; source: string;
  saved: boolean; owned: boolean; sharedBy: string | null; sharedAt: string | null; sharedWithStorekeeper: boolean;
  updatedAt: string;
}
export interface ArtifactRow { artifactId: string; title: string; kind: Kind; version: number; saved: boolean; sharedBy: string | null; sharedWithStorekeeper: boolean; updatedAt: string }

const notFound = () => new ToolError('NOT_FOUND', "Couldn't find that artifact.", undefined, 'artifactId');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One AuditEvent for an artifact action that is not a form (making, editing, saving, restoring, downloading). */
export async function auditArtifact(db: Db, e: { who: ToolSession; entityId: string; action: string; toolName?: string; openedFrom?: 'CHAT' | 'AGENT'; reason?: string; after?: Prisma.InputJsonValue; agentRunId?: string }) {
  await db.auditEvent.create({
    data: { entityType: 'Artifact', entityId: e.entityId, action: e.action, actorType: e.openedFrom === 'AGENT' ? 'AGENT' : 'HUMAN', actorId: e.who.userId, toolName: e.toolName, openedFrom: e.openedFrom ?? 'CHAT', reason: e.reason, afterJson: e.after, agentRunId: e.agentRunId },
  });
}

export async function createArtifact(db: Db, a: { ownerId: string; conversationId?: string | null; kind: Kind; title: string; source: string; request: string; summary?: string | null; checkReport: Prisma.InputJsonValue }) {
  const artifact = await db.artifact.create({ data: { ownerId: a.ownerId, conversationId: a.conversationId ?? null, title: a.title.slice(0, 120), kind: fromKind(a.kind) } });
  const version = await db.artifactVersion.create({ data: { artifactId: artifact.id, n: 1, source: a.source, request: a.request.slice(0, 2000), summary: a.summary ?? null, madeBy: 'AGENT', checkReport: a.checkReport } });
  await db.artifact.update({ where: { id: artifact.id }, data: { currentVersionId: version.id } });
  return { artifactId: artifact.id, version: 1, versionId: version.id };
}

/** A new version, live at once. Nothing is ever edited in place or deleted; at 100 versions the person is asked to save a copy instead. */
export async function addVersion(db: Db, artifactId: string, v: { source: string; request: string; summary?: string | null; madeBy: 'AGENT' | 'RESTORE'; checkReport: Prisma.InputJsonValue; title?: string }) {
  const last = await db.artifactVersion.findFirst({ where: { artifactId }, orderBy: { n: 'desc' }, select: { n: true } });
  const n = (last?.n ?? 0) + 1;
  if (n > MAX_VERSIONS) throw new ToolError('TOO_MANY_VERSIONS', `This has ${MAX_VERSIONS} versions, which is the most. Make a new one as a copy instead.`, undefined, 'artifactId');
  const version = await db.artifactVersion.create({ data: { artifactId, n, source: v.source, request: v.request.slice(0, 2000), summary: v.summary ?? null, madeBy: v.madeBy, checkReport: v.checkReport } });
  await db.artifact.update({ where: { id: artifactId }, data: { currentVersionId: version.id, ...(v.title ? { title: v.title.slice(0, 120) } : {}) } });
  return { version: n, versionId: version.id };
}

/** What this person may open: their own (current version) or one shared with them (the frozen version they were given). */
export async function accessFor(db: Db, who: Pick<ToolSession, 'userId'>, artifactId: string): Promise<ArtifactView> {
  if (!UUID.test(artifactId)) throw notFound();
  const a = await db.artifact.findUnique({
    where: { id: artifactId },
    include: { currentVersion: true, owner: { select: { name: true } }, _count: { select: { versions: true } }, shares: { where: { revokedAt: null }, include: { version: true } } },
  });
  if (!a || a.status !== 'ACTIVE' || !a.currentVersion) throw notFound();
  const sharedWithStorekeeper = a.shares.length > 0;
  if (a.ownerId === who.userId) {
    return { artifactId: a.id, title: a.title, kind: toKind(a.kind), version: a.currentVersion.n, versions: a._count.versions, source: a.currentVersion.source, saved: !!a.savedAt, owned: true, sharedBy: null, sharedAt: null, sharedWithStorekeeper, updatedAt: a.currentVersion.createdAt.toISOString() };
  }
  const share = a.shares.find((s) => s.toUserId === who.userId);
  if (!share) throw notFound();
  return { artifactId: a.id, title: a.title, kind: toKind(a.kind), version: share.version.n, versions: 1, source: share.version.source, saved: false, owned: false, sharedBy: a.owner.name, sharedAt: share.sharedAt.toISOString(), sharedWithStorekeeper: false, updatedAt: share.version.createdAt.toISOString() };
}

export async function listFor(db: Db, who: Pick<ToolSession, 'userId'>, query?: string): Promise<{ mine: ArtifactRow[]; shared: ArtifactRow[] }> {
  const q = (query ?? '').trim();
  const own = await db.artifact.findMany({
    where: { ownerId: who.userId, status: 'ACTIVE', ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}) },
    include: { currentVersion: { select: { n: true, createdAt: true } }, shares: { where: { revokedAt: null }, select: { id: true } } },
    orderBy: [{ savedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }], take: 50,
  });
  const given = await db.artifactShare.findMany({
    where: { toUserId: who.userId, revokedAt: null, artifact: { status: 'ACTIVE', ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}) } },
    include: { artifact: { include: { owner: { select: { name: true } } } }, version: { select: { n: true, createdAt: true } } }, orderBy: { sharedAt: 'desc' }, take: 50,
  });
  return {
    mine: own.filter((a) => a.currentVersion).map((a) => ({ artifactId: a.id, title: a.title, kind: toKind(a.kind), version: a.currentVersion!.n, saved: !!a.savedAt, sharedBy: null, sharedWithStorekeeper: a.shares.length > 0, updatedAt: a.currentVersion!.createdAt.toISOString() })),
    shared: given.map((s) => ({ artifactId: s.artifactId, title: s.artifact.title, kind: toKind(s.artifact.kind), version: s.version.n, saved: false, sharedBy: s.artifact.owner.name, sharedWithStorekeeper: false, updatedAt: s.version.createdAt.toISOString() })),
  };
}

export async function versionsOf(db: Db, owner: Pick<ToolSession, 'userId'>, artifactId: string) {
  const a = await db.artifact.findFirst({ where: { id: artifactId, ownerId: owner.userId, status: 'ACTIVE' }, select: { id: true } });
  if (!a) throw notFound();
  const rows = await db.artifactVersion.findMany({ where: { artifactId }, orderBy: { n: 'desc' }, select: { n: true, request: true, summary: true, madeBy: true, createdAt: true } });
  return rows.map((v) => ({ n: v.n, request: v.request, summary: v.summary, restored: v.madeBy === 'RESTORE', at: v.createdAt.toISOString() }));
}

async function ownOrThrow(db: Db, owner: Pick<ToolSession, 'userId'>, artifactId: string) {
  const a = UUID.test(artifactId) ? await db.artifact.findFirst({ where: { id: artifactId, ownerId: owner.userId, status: 'ACTIVE' } }) : null;
  if (!a) throw notFound();
  return a;
}

export async function setSaved(db: Db, owner: Pick<ToolSession, 'userId'>, artifactId: string, saved: boolean) {
  await ownOrThrow(db, owner, artifactId);
  await db.artifact.update({ where: { id: artifactId }, data: { savedAt: saved ? new Date() : null } });
}

/** "Delete" archives it: it leaves the lists, and nothing is physically removed (a shared copy is frozen and stays in the audit trail). */
export async function archive(db: Db, owner: Pick<ToolSession, 'userId'>, artifactId: string) {
  await ownOrThrow(db, owner, artifactId);
  await db.artifact.update({ where: { id: artifactId }, data: { status: 'ARCHIVED' } });
  await db.artifactShare.updateMany({ where: { artifactId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** An old version becomes current as a NEW version. Nothing is deleted. */
export async function restore(db: Db, owner: Pick<ToolSession, 'userId'>, artifactId: string, n: number) {
  await ownOrThrow(db, owner, artifactId);
  const old = await db.artifactVersion.findUnique({ where: { artifactId_n: { artifactId, n } } });
  if (!old) throw new ToolError('NOT_FOUND', "Couldn't find that version.", undefined, 'version');
  return addVersion(db, artifactId, { source: old.source, request: `Restored version ${n}`, summary: `Went back to version ${n}.`, madeBy: 'RESTORE', checkReport: old.checkReport as Prisma.InputJsonValue });
}

/** Builds by this person in the last hour (the cost guard: 20). */
export const buildsLastHour = (db: Db, ownerId: string, now = new Date()) =>
  db.artifactVersion.count({ where: { madeBy: 'AGENT', artifact: { ownerId }, createdAt: { gt: new Date(now.getTime() - 3_600_000) } } });

/** A frozen version for every active storekeeper; an older share of the same artifact is replaced, not kept. */
export async function shareVersion(db: Db, a: { artifactId: string; n: number; byId: string }) {
  const version = await db.artifactVersion.findUnique({ where: { artifactId_n: { artifactId: a.artifactId, n: a.n } } });
  if (!version) throw new ToolError('NOT_FOUND', "Couldn't find that version.", undefined, 'version');
  const people = await db.user.findMany({ where: { role: 'STOREKEEPER', isActive: true }, select: { id: true, name: true } });
  if (!people.length) throw new ToolError('NO_STOREKEEPER', 'There is no storekeeper to share it with.', undefined, 'artifactId');
  await db.artifactShare.updateMany({ where: { artifactId: a.artifactId, revokedAt: null }, data: { revokedAt: new Date() } });
  for (const p of people) await db.artifactShare.create({ data: { artifactId: a.artifactId, versionId: version.id, toUserId: p.id, sharedById: a.byId } });
  return { version: version.n, with: people.map((p) => p.name) };
}

export async function unshare(db: Db, artifactId: string) {
  const r = await db.artifactShare.updateMany({ where: { artifactId, revokedAt: null }, data: { revokedAt: new Date() } });
  return r.count;
}

export async function titleAndKind(db: Db, artifactId: string) {
  const a = await db.artifact.findUnique({ where: { id: artifactId }, select: { title: true, kind: true, currentVersion: { select: { n: true, source: true } }, ownerId: true, status: true } });
  return a && a.status === 'ACTIVE' ? { ownerId: a.ownerId, title: a.title, kind: toKind(a.kind), n: a.currentVersion?.n ?? 0, source: a.currentVersion?.source ?? '' } : null;
}

// The same functions, bound to the app's database, for the routes (which may not import the database themselves).
import { db as appDb } from '../db';
export const openFor = (who: Pick<ToolSession, 'userId'>, artifactId: string) => accessFor(appDb, who, artifactId);
export const record = (e: Parameters<typeof auditArtifact>[1]) => auditArtifact(appDb, e);
