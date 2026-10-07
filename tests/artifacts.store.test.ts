import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma, makeUser, resetDb } from './helpers/db';
import { fails, ok, owner, save, seedSettings, storekeeper } from './helpers/tools';
import * as store from '@/server/artifacts/store';
import { db } from '@/server/db';

beforeEach(async () => { await resetDb(); await seedSettings(); });
afterAll(() => prisma.$disconnect());

const DOC = (title: string, tool = 'list_reorder_alerts') => `---\ntitle: ${title}\nreads:\n  alerts: ${tool} {}\n---\n**{{alerts.count}}** found.\n`;
const OWNER_DOC = `---\ntitle: Stock position\nreads:\n  value: get_stock_value {}\n---\nWorth {{value.total|inr}}.\n`;
const make = (ownerId: string, source = DOC('Below minimum'), title = 'Below minimum') =>
  store.createArtifact(db, { ownerId, kind: 'document', title, source, request: 'a report', checkReport: {} });

describe('artifacts: versions, saving, restoring (ARTIFACTS §3.2, §5)', () => {
  it('a make is version 1; an edit is version 2; nothing is edited in place', async () => {
    const o = await owner();
    const a = await make(o.userId);
    expect(a.version).toBe(1);
    const v2 = await store.addVersion(db, a.artifactId, { source: DOC('Below minimum, with supplier'), request: 'add a supplier', summary: 'Added it.', madeBy: 'AGENT', checkReport: {} });
    expect(v2.version).toBe(2);
    const view = await store.accessFor(db, o, a.artifactId);
    expect(view).toMatchObject({ version: 2, versions: 2, owned: true });
    await expect(prisma.$executeRaw`UPDATE artifact_versions SET source = 'x'`).rejects.toThrow(/LEDGER_APPEND_ONLY/);
    await expect(prisma.$executeRaw`DELETE FROM artifact_versions`).rejects.toThrow(/LEDGER_APPEND_ONLY/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE artifact_versions CASCADE')).rejects.toThrow(/LEDGER_APPEND_ONLY/);
  });

  it('restore makes an old version current as a NEW version; the old ones all stay', async () => {
    const o = await owner();
    const a = await make(o.userId);
    await store.addVersion(db, a.artifactId, { source: DOC('Changed'), request: 'change', madeBy: 'AGENT', checkReport: {} });
    const r = await store.restore(db, o, a.artifactId, 1);
    expect(r.version).toBe(3);
    const versions = await store.versionsOf(db, o, a.artifactId);
    expect(versions.map((v) => [v.n, v.restored])).toEqual([[3, true], [2, false], [1, false]]);
    expect((await store.accessFor(db, o, a.artifactId)).source).toBe(DOC('Below minimum'));
  });

  it('stops at 100 versions and says to make a copy instead', async () => {
    const o = await owner();
    const a = await make(o.userId);
    for (let i = 2; i <= store.MAX_VERSIONS; i++) await store.addVersion(db, a.artifactId, { source: DOC(`v${i}`), request: 'x', madeBy: 'AGENT', checkReport: {} });
    await expect(store.addVersion(db, a.artifactId, { source: DOC('one more'), request: 'x', madeBy: 'AGENT', checkReport: {} })).rejects.toMatchObject({ code: 'TOO_MANY_VERSIONS' });
  }, 60_000);

  it('Save keeps it under Saved first; Delete archives it and nothing is physically removed', async () => {
    const o = await owner();
    const a = await make(o.userId, DOC('Recent one'), 'Recent one');
    const b = await make(o.userId, DOC('Kept one'), 'Kept one');
    await store.setSaved(db, o, b.artifactId, true);
    let list = await store.listFor(db, o);
    expect(list.mine.map((x) => [x.title, x.saved])).toEqual([['Kept one', true], ['Recent one', false]]);
    await store.archive(db, o, a.artifactId);
    list = await store.listFor(db, o);
    expect(list.mine.map((x) => x.title)).toEqual(['Kept one']);
    expect(await prisma.artifact.count()).toBe(2);
    expect(await prisma.artifactVersion.count()).toBe(2);
    await expect(store.accessFor(db, o, a.artifactId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('only the owner of an artifact can open, save, restore or archive it; a stranger gets "not found"', async () => {
    const o = await owner(); const s = await storekeeper();
    const a = await make(o.userId);
    await expect(store.accessFor(db, s, a.artifactId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.setSaved(db, s, a.artifactId, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.restore(db, s, a.artifactId, 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.archive(db, s, a.artifactId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await store.listFor(db, s)).mine).toEqual([]);
  });

  it('twenty builds an hour is the most; the count is by who made them and when', async () => {
    const o = await owner();
    for (let i = 0; i < 3; i++) await make(o.userId, DOC(`n${i}`), `n${i}`);
    expect(await store.buildsLastHour(db, o.userId)).toBe(3);
    expect(await store.buildsLastHour(db, o.userId, new Date(Date.now() + 2 * 3_600_000))).toBe(0);
    expect(await store.buildsLastHour(db, (await storekeeper()).userId)).toBe(0);
  });
});

describe('sharing with the storekeeper (ARTIFACTS §6)', () => {
  it('he gets a frozen copy: editing later changes nothing for him until the owner shares the newer version', async () => {
    const o = await owner(); const s = await storekeeper();
    const a = await make(o.userId);
    const f = await ok<{ version: number }>(save(o, 'share_artifact', { artifactId: a.artifactId }));
    expect(f.version).toBe(1);
    await store.addVersion(db, a.artifactId, { source: DOC('Changed after sharing'), request: 'edit', madeBy: 'AGENT', checkReport: {} });
    const his = await store.accessFor(db, s, a.artifactId);
    expect(his).toMatchObject({ version: 1, owned: false, sharedBy: o.name });
    expect(his.source).toBe(DOC('Below minimum'));
    await ok(save(o, 'share_artifact', { artifactId: a.artifactId }));
    expect((await store.accessFor(db, s, a.artifactId)).version).toBe(2);
    expect(await prisma.artifactShare.count({ where: { revokedAt: null } })).toBe(1); // the old share was replaced, not kept
  });

  it('he can open it, but not share, save, restore, archive or see its versions', async () => {
    const o = await owner(); const s = await storekeeper();
    const a = await make(o.userId);
    await ok(save(o, 'share_artifact', { artifactId: a.artifactId }));
    expect((await store.listFor(db, s)).shared.map((x) => x.title)).toEqual(['Below minimum']);
    await expect(store.setSaved(db, s, a.artifactId, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.versionsOf(db, s, a.artifactId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await fails(save(s, 'share_artifact', { artifactId: a.artifactId }))).code).toBe('FORBIDDEN_ROLE');
  });

  it('is refused when it reads an owner-only tool, and says which', async () => {
    const o = await owner();
    const a = await make(o.userId, OWNER_DOC, 'Stock position');
    const f = await fails(save(o, 'share_artifact', { artifactId: a.artifactId }));
    expect(f).toMatchObject({ code: 'NOT_SHAREABLE', field: 'artifactId' });
    expect(f.message).toContain('get_stock_value');
    expect(await prisma.artifactShare.count()).toBe(0);
  });

  it('unshare takes it out of his Saved at once; the owner\'s own copy stays; both are audited', async () => {
    const o = await owner(); const s = await storekeeper();
    const a = await make(o.userId);
    await ok(save(o, 'share_artifact', { artifactId: a.artifactId }));
    await ok(save(o, 'unshare_artifact', { artifactId: a.artifactId }));
    await expect(store.accessFor(db, s, a.artifactId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await store.listFor(db, s)).shared).toEqual([]);
    expect((await store.accessFor(db, o, a.artifactId)).owned).toBe(true);
    expect((await fails(save(o, 'unshare_artifact', { artifactId: a.artifactId }))).code).toBe('NOT_SHARED');
    const audit = await prisma.auditEvent.findMany({ where: { entityType: 'Artifact' }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((e) => e.action)).toEqual(['SHARE', 'UNSHARE']);
  });

  it('a version that is not the current one can be shared; one that does not exist cannot', async () => {
    const o = await owner(); const s = await storekeeper();
    const a = await make(o.userId);
    await store.addVersion(db, a.artifactId, { source: DOC('Second'), request: 'x', madeBy: 'AGENT', checkReport: {} });
    await ok(save(o, 'share_artifact', { artifactId: a.artifactId, version: 1 }));
    expect((await store.accessFor(db, s, a.artifactId)).version).toBe(1);
    expect((await fails(save(o, 'share_artifact', { artifactId: a.artifactId, version: 9 }))).code).toBe('NOT_FOUND');
  });

  it('archiving something shared stops the share', async () => {
    const o = await owner(); const s = await storekeeper();
    const a = await make(o.userId);
    await ok(save(o, 'share_artifact', { artifactId: a.artifactId }));
    await store.archive(db, o, a.artifactId);
    await expect(store.accessFor(db, s, a.artifactId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the storekeeper\'s own artifacts are his; the owner cannot open them by their number', async () => {
    const s = await storekeeper(); const o = await owner();
    const mine = await make(s.userId, DOC('Issued this week', 'get_movement_history'), 'Issued this week');
    await expect(store.accessFor(db, o, mine.artifactId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    void makeUser;
  });
});
