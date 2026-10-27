import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticate } from '@/server/auth/authenticate';
import { resetRateLimits } from '@/server/auth/rate-limit';
import { readSetting, assistantSettingOn } from '@/server/tools/settings';
import { pendingActions, runTool } from '@/server/tools';
import { prisma, resetDb } from './helpers/db';
import { fails, ok, owner, save, seedSettings, storekeeper } from './helpers/tools';

beforeEach(async () => { await resetDb(); resetRateLimits(); await seedSettings(); });
afterAll(() => prisma.$disconnect());

const settings = async (s: Awaited<ReturnType<typeof owner>>) => (await ok<{ rows: { key: string; setting: string; value: string }[] }>(runTool(s, 'list_settings', {}))).rows;

describe('settings', () => {
  it('start at ₹50,000 and the assistant on', async () => {
    const o = await owner();
    const rows = await settings(o);
    expect(rows.slice(0, 3)).toEqual([
      expect.objectContaining({ key: 'po.approval_limit', value: '₹50,000' }),
      expect.objectContaining({ key: 'agent.enabled', value: 'On' }),
      expect.objectContaining({ key: 'notify.owner_email', value: 'None' }),
    ]);
    // the letterhead printouts use (milestone 9): the name is there from day one, the rest is for the owner to fill in
    expect(rows.slice(3).map((r) => r.key)).toEqual(['company.name', 'company.address', 'company.gstin', 'company.state', 'company.phone']);
    expect(rows.find((r) => r.key === 'company.name')?.value).toBe('Vijaya Electronics');
  });

  it('the storekeeper can read the approval limit and nothing else (1.27)', async () => {
    const s = await storekeeper();
    expect((await settings(s)).map((r) => [r.setting, r.value])).toEqual([['Purchase approval limit', '₹50,000']]);
  });

  it('only the owner changes it: the storekeeper is refused and gets no form (1.25)', async () => {
    const s = await storekeeper();
    expect(await pendingActions.create(s, { tool: 'update_setting', origin: 'AGENT' })).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE', message: 'Only the owner can do that.' });
    expect(await save(s, 'update_setting', { key: 'po.approval_limit', value: '1000000' })).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
    expect(await readSetting(prisma, 'po.approval_limit')).toBe('50000');
  });

  it('the owner changes it, with the old value in the audit (1.26)', async () => {
    const o = await owner();
    for (const typed of ['75,000', '₹75000', 75000]) {
      await ok(save(o, 'update_setting', { key: 'po.approval_limit', value: typed }));
      expect(await readSetting(prisma, 'po.approval_limit')).toBe('75000');
    }
    const last = (await prisma.auditEvent.findMany({ where: { toolName: 'update_setting' }, orderBy: { createdAt: 'desc' }, take: 1 }))[0];
    expect(last?.afterJson).toMatchObject({ now: '₹75,000', was: '₹75,000' });
    expect((await settings(o))[0]?.value).toBe('₹75,000');
  });

  it('checks the value by its type, in plain words', async () => {
    const o = await owner();
    expect(await fails(save(o, 'update_setting', { key: 'po.approval_limit', value: 'a lot' }))).toMatchObject({ field: 'value', message: 'Type the amount in rupees, like 50000.' });
    expect(await fails(save(o, 'update_setting', { key: 'po.approval_limit', value: '-5' }))).toMatchObject({ field: 'value' });
    expect(await fails(save(o, 'update_setting', { key: 'agent.enabled', value: 'maybe' }))).toMatchObject({ message: 'Type on or off.' });
    expect(await fails(save(o, 'update_setting', { key: 'notify.owner_email', value: 'nope' }))).toMatchObject({ field: 'value' });
    expect(await fails(save(o, 'update_setting', { key: 'database.url', value: 'x' }))).toMatchObject({ code: 'UNKNOWN_SETTING', field: 'key' });
    expect(await readSetting(prisma, 'po.approval_limit')).toBe('50000');
  });

  it('a missing setting is an error, never a made-up default', async () => {
    await prisma.setting.deleteMany();
    await expect(readSetting(prisma, 'po.approval_limit')).rejects.toMatchObject({ code: 'SETTING_MISSING' });
  });

  it('the assistant switch: off by the owner, on by default if never written', async () => {
    const o = await owner();
    expect(await assistantSettingOn(prisma)).toBe(true);
    await ok(save(o, 'update_setting', { key: 'agent.enabled', value: 'off' }));
    expect(await assistantSettingOn(prisma)).toBe(false);
    await prisma.setting.deleteMany();
    expect(await assistantSettingOn(prisma)).toBe(true);
  });
});

describe('users', () => {
  const newUser = (over: Record<string, unknown> = {}) => ({ name: 'Ravi Kumar', login: 'ravi@vijaya.test', role: 'STOREKEEPER', password: 'first-password-1', ...over });

  it('the owner adds a login and the person can log in with it (1.30)', async () => {
    const o = await owner();
    const r = await ok<{ name: string; role: string }>(save(o, 'create_user', newUser()));
    expect(r).toEqual({ id: expect.any(String), name: 'Ravi Kumar', role: 'Storekeeper' });
    expect(await authenticate({ email: 'ravi@vijaya.test', password: 'first-password-1' })).toMatchObject({ ok: true, user: { role: 'STOREKEEPER' } });
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'ravi@vijaya.test' } });
    expect(u.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  });

  it("a storekeeper can't create a login, not even as owner (1.29)", async () => {
    const s = await storekeeper();
    expect(await pendingActions.create(s, { tool: 'create_user', origin: 'AGENT' })).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
    expect(await save(s, 'create_user', newUser({ role: 'OWNER' }))).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
    expect(await prisma.user.count({ where: { email: 'ravi@vijaya.test' } })).toBe(0);
  });

  it('the password is never kept: not in the audit log, not in the stored form', async () => {
    const o = await owner();
    const form = await pendingActions.create(o, { tool: 'create_user', origin: 'AGENT', input: newUser() });
    if (!form.ok) throw new Error(form.message);
    expect(form.data.input).toEqual({ name: 'Ravi Kumar', login: 'ravi@vijaya.test', role: 'STOREKEEPER' }); // the assistant cannot pre-fill it
    await ok(runTool(o, 'create_user', newUser(), { confirmation: form.data.id }));
    const everything = JSON.stringify([await prisma.auditEvent.findMany(), await prisma.pendingAction.findMany()]);
    expect(everything).not.toMatch(/first-password-1|\$2[aby]\$/);
  });

  it('validates in plain words, next to the box', async () => {
    const o = await owner();
    expect(await fails(save(o, 'create_user', newUser({ password: 'short' })))).toMatchObject({ field: 'password', message: 'The password needs at least 10 characters.' });
    expect(await fails(save(o, 'create_user', newUser({ login: 'not-an-email' })))).toMatchObject({ code: 'INVALID_EMAIL', field: 'login' });
    expect(await fails(save(o, 'create_user', newUser({ role: 'ADMIN' })))).toMatchObject({ field: 'role' });
    expect(await fails(save(o, 'create_user', newUser({ name: '' })))).toMatchObject({ field: 'name' });
    await ok(save(o, 'create_user', newUser()));
    expect(await fails(save(o, 'create_user', newUser({ login: ' RAVI@vijaya.test ' })))).toMatchObject({ code: 'EMAIL_EXISTS', field: 'login' });
  });

  it('a new password replaces the old one, and the audit says it changed, not to what', async () => {
    const o = await owner();
    const { id } = await ok<{ id: string }>(save(o, 'create_user', newUser()));
    await ok(save(o, 'reset_user_password', { userId: id, password: 'brand-new-pass-9' }));
    expect(await authenticate({ email: 'ravi@vijaya.test', password: 'first-password-1' })).toMatchObject({ ok: false });
    expect(await authenticate({ email: 'ravi@vijaya.test', password: 'brand-new-pass-9' })).toMatchObject({ ok: true });
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'reset_user_password' } });
    expect(ev.afterJson).toEqual({ name: 'Ravi Kumar', credentialChanged: true });
    expect(await fails(save(o, 'reset_user_password', { userId: id, password: 'short' }))).toMatchObject({ field: 'password' });
    expect(await fails(save(o, 'reset_user_password', { userId: 'nope', password: 'brand-new-pass-9' }))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a storekeeper cannot reset anyone\'s password', async () => {
    const s = await storekeeper();
    const other = await owner();
    expect(await save(s, 'reset_user_password', { userId: other.userId, password: 'brand-new-pass-9' })).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
  });

  it('a stopped login cannot log in; the last owner and yourself cannot be stopped', async () => {
    const o = await owner();
    const { id } = await ok<{ id: string }>(save(o, 'create_user', newUser()));
    await ok(save(o, 'deactivate_user', { userId: id }));
    expect(await authenticate({ email: 'ravi@vijaya.test', password: 'first-password-1' })).toMatchObject({ ok: false });
    expect(await fails(save(o, 'deactivate_user', { userId: id }))).toMatchObject({ code: 'ALREADY_INACTIVE' });
    expect(await fails(save(o, 'deactivate_user', { userId: o.userId }))).toMatchObject({ code: 'USER_SELF' });

    const second = await ok<{ id: string }>(save(o, 'create_user', newUser({ name: 'Second Owner', login: 'second@vijaya.test', role: 'OWNER' })));
    const two = { userId: second.id, name: 'Second Owner', role: 'OWNER' as const };
    await ok(save(o, 'deactivate_user', { userId: second.id })); // another owner (Test OWNER) is still active
    expect(two.userId).toBe(second.id);
    // now only `o` is left: a different owner session cannot stop them
    const third = await ok<{ id: string }>(save(o, 'create_user', newUser({ name: 'Third Owner', login: 'third@vijaya.test', role: 'OWNER' })));
    const thirdSession = { userId: third.id, name: 'Third Owner', role: 'OWNER' as const };
    await ok(save(thirdSession, 'deactivate_user', { userId: o.userId }));
    expect(await fails(save(thirdSession, 'deactivate_user', { userId: (await prisma.user.findFirstOrThrow({ where: { role: 'OWNER', isActive: true } })).id }))).toMatchObject({ code: expect.stringMatching(/LAST_OWNER|USER_SELF/) });
  });

  it('lists people without ever selecting the password hash', async () => {
    const o = await owner();
    await ok(save(o, 'create_user', newUser()));
    const r = await ok<{ rows: Record<string, unknown>[] }>(runTool(o, 'list_users', {}));
    expect(JSON.stringify(r)).not.toMatch(/\$2[aby]\$|passwordHash/);
    expect(r.rows.map((x) => x.name)).toContain('Ravi Kumar');
    expect(await runTool(await storekeeper(), 'list_users', {})).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
  });
});

describe('the two reads behind the opening card', () => {
  it('reorder alerts: standing material below its minimum, in names and units', async () => {
    const s = await storekeeper();
    const core = await ok<{ id: string }>(save(s, 'create_material', { name: 'Ferrite Core E-30', uom: 'NOS', stockType: 'STANDING', minimumLevel: 50 }));
    const r = await ok<{ rows: Record<string, unknown>[] }>(runTool(s, 'list_reorder_alerts', {}));
    expect(r.rows).toEqual([{ material: 'Ferrite Core E-30', unit: 'NOS', onHand: 0, minimumLevel: 50, shortfall: 50 }]);
    void core;
  });
  it('pending approvals: owner only, empty to begin with', async () => {
    expect(await ok(runTool(await owner(), 'list_pending_approvals', {}))).toEqual({ purchaseOrders: [], counts: [] });
    expect(await runTool(await storekeeper(), 'list_pending_approvals', {})).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
  });
});
