import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PENDING_TTL_MS } from '@/server/tools/pending';
import { prisma, resetDb } from './helpers/db';
import { pending, session } from './helpers/gateway';

beforeEach(() => resetDb());
afterAll(() => prisma.$disconnect());

const stored = async (id: string) => prisma.pendingAction.findUniqueOrThrow({ where: { id } });

describe('opening a form', () => {
  it('a launcher button opens an empty form, whatever it is handed', async () => {
    const s = await session();
    const r = await pending.create(s, { tool: 'create_material', origin: 'LAUNCHER', input: { name: 'Sneaky', uom: 'KG' } });
    expect(r).toMatchObject({ ok: true, data: { tool: 'create_material', input: {}, assisted: false } });
    expect((await stored((r as { data: { id: string } }).data.id)).proposedInput).toEqual({});
  });

  it("the assistant's suggestions are cleaned on the server, and the cleaned version is what is stored", async () => {
    const s = await session();
    const r = await pending.create(s, {
      tool: 'create_material', origin: 'AGENT',
      input: { name: 'Ferrite Core E-30', uom: 'NOS', evil: 'x', minimumLevel: 50, hsnCode: 'x'.repeat(500) },
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.data.input).toEqual({ name: 'Ferrite Core E-30', uom: 'NOS', minimumLevel: 50 });
    expect(r.data.dropped).toEqual(expect.arrayContaining(['evil', 'hsnCode']));
    expect(r.data.assisted).toBe(true); // → the "assistant filled this in" badge
    expect((await stored(r.data.id)).proposedInput).toEqual(r.data.input); // never the raw input
  });

  it('a rate is never pre-filled by the assistant or an artifact — it must be typed from the invoice', async () => {
    const s = await session();
    for (const origin of ['AGENT', 'ARTIFACT'] as const) {
      const r = await pending.create(s, { tool: 'record_scrap_sale', origin, input: { quantity: 40, rate: 750, invoiceNo: 'INV-9' } });
      if (!r.ok) throw new Error(r.message);
      expect(r.data.input).toEqual({ quantity: 40, invoiceNo: 'INV-9' });
      expect(r.data.dropped).toContain('rate');
      expect(JSON.stringify((await stored(r.data.id)).proposedInput)).not.toMatch(/rate|750/);
    }
  });

  it('is refused for an unknown tool, for a read tool, and for a tool the role may not use', async () => {
    const sk = await session('STOREKEEPER');
    expect(await pending.create(sk, { tool: 'list_rows', origin: 'AGENT' })).toMatchObject({ ok: false, code: 'UNKNOWN_TOOL' });
    expect(await pending.create(sk, { tool: 'list_jobs', origin: 'LAUNCHER' })).toMatchObject({ ok: false, code: 'NOT_A_FORM' });
    expect(await pending.create(sk, { tool: 'create_user', origin: 'AGENT' })).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE', message: 'Only the owner can do that.' });
    expect(await prisma.pendingAction.count()).toBe(0);
  });

  it('an artifact can open everyday forms only — never an admin form, even for the owner', async () => {
    const owner = await session('OWNER');
    expect(await pending.create(owner, { tool: 'create_material', origin: 'ARTIFACT', artifactId: 'a', artifactVersion: 1 })).toMatchObject({ ok: true });
    expect(await pending.create(owner, { tool: 'create_user', origin: 'ARTIFACT' })).toMatchObject({ ok: false, code: 'FORM_NOT_ALLOWED' });
    const stored1 = await prisma.pendingAction.findFirstOrThrow({ where: { toolName: 'create_material' } });
    expect(stored1).toMatchObject({ origin: 'ARTIFACT', artifactId: 'a', artifactVersion: 1 });
  });

  it('expires in 15 minutes', async () => {
    const s = await session();
    const now = new Date('2026-10-07T10:00:00Z');
    const r = await pending.create(s, { tool: 'create_material', origin: 'LAUNCHER' }, now);
    if (!r.ok) throw new Error(r.message);
    expect(PENDING_TTL_MS).toBe(15 * 60 * 1000);
    expect(r.data.expiresAt.toISOString()).toBe('2026-10-07T10:15:00.000Z');
    expect(await pending.get(s, r.data.id, new Date('2026-10-07T10:14:59Z'))).not.toBeNull();
    expect(await pending.get(s, r.data.id, new Date('2026-10-07T10:15:01Z'))).toBeNull();
  });
});

describe('replacing and closing', () => {
  it('opening the same form again in the same chat closes the earlier one ("issue for job 31… actually job 32")', async () => {
    const s = await session();
    const chat = await prisma.conversation.create({ data: { userId: s.userId } });
    const first = await pending.create(s, { tool: 'create_material', origin: 'AGENT', conversationId: chat.id, input: { name: 'First' } });
    const second = await pending.create(s, { tool: 'create_material', origin: 'AGENT', conversationId: chat.id, input: { name: 'Second' } });
    if (!first.ok || !second.ok) throw new Error('setup');
    expect((await stored(first.data.id)).status).toBe('CANCELLED');
    expect((await stored(second.data.id)).status).toBe('OPEN');
  });

  it('does not touch another tool, another chat, or another person', async () => {
    const a = await session('OWNER');
    const b = await session('STOREKEEPER');
    const chat1 = await prisma.conversation.create({ data: { userId: a.userId } });
    const chat2 = await prisma.conversation.create({ data: { userId: a.userId } });
    const keep1 = await pending.create(a, { tool: 'create_user', origin: 'AGENT', conversationId: chat1.id });
    const keep2 = await pending.create(a, { tool: 'create_material', origin: 'AGENT', conversationId: chat1.id });
    const keep3 = await pending.create(a, { tool: 'create_material', origin: 'AGENT', conversationId: chat2.id });
    const keep4 = await pending.create(b, { tool: 'create_material', origin: 'AGENT', conversationId: undefined });
    await pending.create(a, { tool: 'create_material', origin: 'AGENT', conversationId: chat1.id }); // replaces only keep2
    for (const k of [keep1, keep3, keep4]) expect((await stored((k as { data: { id: string } }).data.id)).status).toBe('OPEN');
    expect((await stored((keep2 as { data: { id: string } }).data.id)).status).toBe('CANCELLED');
  });

  it("cannot attach a form to someone else's chat", async () => {
    const a = await session('OWNER');
    const b = await session('STOREKEEPER');
    const chat = await prisma.conversation.create({ data: { userId: a.userId } });
    expect(await pending.create(b, { tool: 'create_material', origin: 'AGENT', conversationId: chat.id })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('"Not now" closes your own open form, and only yours', async () => {
    const a = await session('OWNER');
    const b = await session('STOREKEEPER');
    const r = await pending.create(a, { tool: 'create_material', origin: 'LAUNCHER' });
    if (!r.ok) throw new Error('setup');
    expect(await pending.cancel(b, r.data.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await pending.get(a, r.data.id)).not.toBeNull();
    expect(await pending.cancel(a, r.data.id)).toMatchObject({ ok: true });
    expect(await pending.get(a, r.data.id)).toBeNull();
    expect(await pending.cancel(a, r.data.id)).toMatchObject({ ok: false }); // already closed
  });

  it("you can only load your own form", async () => {
    const a = await session('OWNER');
    const b = await session('STOREKEEPER');
    const r = await pending.create(a, { tool: 'create_material', origin: 'LAUNCHER' });
    if (!r.ok) throw new Error('setup');
    expect(await pending.get(b, r.data.id)).toBeNull();
  });

  it('housekeeping marks forms past their time as expired', async () => {
    const s = await session();
    const old = await pending.create(s, { tool: 'create_material', origin: 'LAUNCHER' }, new Date(Date.now() - 3600_000));
    const fresh = await pending.create(await session(), { tool: 'create_material', origin: 'LAUNCHER' });
    if (!old.ok || !fresh.ok) throw new Error('setup');
    expect(await pending.expireStale()).toBe(1);
    expect((await stored(old.data.id)).status).toBe('EXPIRED');
    expect((await stored(fresh.data.id)).status).toBe('OPEN');
  });
});
