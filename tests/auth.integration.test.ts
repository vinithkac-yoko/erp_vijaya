import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authenticate, LOCKED, WRONG } from '@/server/auth/authenticate';
import { hashPassword } from '@/server/auth/password';
import { resetRateLimits } from '@/server/auth/rate-limit';

const prisma = new PrismaClient();

beforeAll(async () => {
  await prisma.user.deleteMany();
  await prisma.user.createMany({
    data: [
      { name: 'Test Owner', email: 'owner@test.local', role: 'OWNER', passwordHash: await hashPassword('owner-password-1') },
      { name: 'Test Storekeeper', email: 'sk@test.local', role: 'STOREKEEPER', passwordHash: await hashPassword('store-password-1') },
      { name: 'Former Helper', email: 'gone@test.local', role: 'STOREKEEPER', passwordHash: await hashPassword('gone-password-1'), isActive: false },
    ],
  });
});
beforeEach(resetRateLimits);
afterAll(() => prisma.$disconnect());

describe('authenticate (real Postgres)', () => {
  it('logs in each role and returns the role from the database', async () => {
    const o = await authenticate({ email: 'owner@test.local', password: 'owner-password-1' });
    const s = await authenticate({ email: 'sk@test.local', password: 'store-password-1' });
    expect(o).toMatchObject({ ok: true, user: { name: 'Test Owner', role: 'OWNER' } });
    expect(s).toMatchObject({ ok: true, user: { name: 'Test Storekeeper', role: 'STOREKEEPER' } });
  });
  it('ignores case and spaces in the email', async () => {
    expect((await authenticate({ email: '  Owner@Test.Local ', password: 'owner-password-1' })).ok).toBe(true);
  });
  it('gives the same message for a wrong password, an unknown email and a deactivated user', async () => {
    const wrongPw = await authenticate({ email: 'owner@test.local', password: 'nope' });
    const unknown = await authenticate({ email: 'nobody@test.local', password: 'nope' });
    const inactive = await authenticate({ email: 'gone@test.local', password: 'gone-password-1' });
    for (const r of [wrongPw, unknown, inactive]) expect(r).toEqual({ ok: false, message: WRONG });
  });
  it('never returns the password hash', async () => {
    const r = await authenticate({ email: 'owner@test.local', password: 'owner-password-1' });
    expect(JSON.stringify(r)).not.toMatch(/\$2[aby]\$|passwordHash/);
  });
  it('asks for missing fields in plain words', async () => {
    expect(await authenticate({ email: '', password: 'x' })).toMatchObject({ ok: false, message: 'Type your email.' });
    expect(await authenticate({ email: 'a@b', password: '' })).toMatchObject({ ok: false, message: 'Type your password.' });
    expect(await authenticate(undefined)).toMatchObject({ ok: false });
  });
  it('locks after 5 wrong tries, even if the 6th password is right', async () => {
    for (let i = 0; i < 5; i++) await authenticate({ email: 'owner@test.local', password: 'bad' }, '5.5.5.5');
    expect(await authenticate({ email: 'owner@test.local', password: 'owner-password-1' }, '5.5.5.5')).toEqual({ ok: false, message: LOCKED });
    // another place is not affected
    expect((await authenticate({ email: 'owner@test.local', password: 'owner-password-1' }, '6.6.6.6')).ok).toBe(true);
  });
});
