import { z } from 'zod';
import { canShare, canShareDoc } from '@/lib/artifacts/check';
import { ToolError } from '../errors';
import { accessFor, shareVersion, unshare } from '../artifacts/store';
import { defineTool } from './define';

/**
 * The owner's two artifact writes (docs/ARTIFACTS.md §6). Like every write they open a form and only the owner's
 * submit does anything. The storekeeper gets a FROZEN copy of the version shared; it runs with HIS role.
 */
const artifactId = z.string({ required_error: 'Choose the artifact.' }).uuid('Choose the artifact.');
const versionOpt = z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : Number(v)), z.number().int().min(1).max(1000).optional());

async function ownedVersion(db: Parameters<typeof accessFor>[0], userId: string, id: string, n?: number) {
  const a = await accessFor(db, { userId }, id);
  if (!a.owned) throw new ToolError('FORBIDDEN_ROLE', 'Only the owner shares artifacts.', undefined, 'artifactId');
  if (n === undefined || n === a.version) return { a, source: a.source, n: a.version };
  const v = await db.artifactVersion.findUnique({ where: { artifactId_n: { artifactId: id, n } } });
  if (!v) throw new ToolError('NOT_FOUND', "Couldn't find that version.", undefined, 'version');
  return { a, source: v.source, n: v.n };
}

export const shareArtifact = defineTool({
  name: 'share_artifact', kind: 'write', roles: ['OWNER'],
  input: z.object({ artifactId, version: versionOpt }),
  form: {
    title: 'Share with the storekeeper', verb: 'Share it',
    intro: 'He gets a copy of this version. It does not change when you edit it later; share the newer version to update his copy. It shows him only what he is allowed to see.',
    fields: [{ name: 'artifactId', label: 'Artifact', type: 'hidden' }, { name: 'version', label: 'Version', type: 'hidden' }],
  },
  stamp: 'SHARED',
  describe: (a) => [`${a.title} · version ${a.version}`, `Shared with ${(a.with as string[]).join(', ')}`, 'His copy stays at this version until you share a newer one.'],
  preview: async (ctx, input) => {
    if (typeof input.artifactId !== 'string' || !input.artifactId) return { info: ['Which artifact? Open it, then press Share.'] };
    try {
      const { a, source, n } = await ownedVersion(ctx.db, ctx.session.userId, input.artifactId, input.version === undefined ? undefined : Number(input.version));
      const ok = a.kind === 'document' ? canShareDoc(source) : canShare(source);
      return { info: [`${a.title} · version ${n}`, ok.ok ? 'The storekeeper gets this version, as it is now.' : (ok.reason ?? 'This cannot be shared.')], values: { artifactId: a.artifactId, version: n } };
    } catch (e) { return { info: [e instanceof ToolError ? e.message : 'Something went wrong.'] }; }
  },
  handler: async (ctx, input) => {
    const { a, source, n } = await ownedVersion(ctx.db, ctx.session.userId, input.artifactId, input.version);
    const ok = a.kind === 'document' ? canShareDoc(source) : canShare(source);
    if (!ok.ok) throw new ToolError('NOT_SHAREABLE', ok.reason ?? 'This cannot be shared.', undefined, 'artifactId');
    const shared = await shareVersion(ctx.db, { artifactId: a.artifactId, n, byId: ctx.session.userId });
    return { data: { artifactId: a.artifactId, title: a.title, version: shared.version }, audit: { entityType: 'Artifact', entityId: a.artifactId, action: 'SHARE', after: { title: a.title, version: shared.version, with: shared.with } } };
  },
});

export const unshareArtifact = defineTool({
  name: 'unshare_artifact', kind: 'write', roles: ['OWNER'],
  input: z.object({ artifactId }),
  form: {
    title: 'Stop sharing', verb: 'Stop sharing', intro: 'It disappears from the storekeeper\'s Saved. Your own copy stays.',
    fields: [{ name: 'artifactId', label: 'Artifact', type: 'hidden' }],
  },
  stamp: 'NOT SHARED ANY MORE',
  describe: (a) => [String(a.title), 'It is gone from the storekeeper\'s Saved. Your copy is untouched.'],
  preview: async (ctx, input) => {
    if (typeof input.artifactId !== 'string' || !input.artifactId) return { info: ['Which artifact? Open it, then press Share.'] };
    try {
      const a = await accessFor(ctx.db, { userId: ctx.session.userId }, input.artifactId);
      return { info: [a.title, a.sharedWithStorekeeper ? 'The storekeeper has a copy now.' : 'It is not shared at the moment.'] };
    } catch (e) { return { info: [e instanceof ToolError ? e.message : 'Something went wrong.'] }; }
  },
  handler: async (ctx, input) => {
    const a = await accessFor(ctx.db, { userId: ctx.session.userId }, input.artifactId);
    if (!a.owned) throw new ToolError('FORBIDDEN_ROLE', 'Only the owner shares artifacts.', undefined, 'artifactId');
    const n = await unshare(ctx.db, a.artifactId);
    if (n === 0) throw new ToolError('NOT_SHARED', 'It is not shared with anyone.', undefined, 'artifactId');
    return { data: { artifactId: a.artifactId, title: a.title }, audit: { entityType: 'Artifact', entityId: a.artifactId, action: 'UNSHARE', after: { title: a.title } } };
  },
});
