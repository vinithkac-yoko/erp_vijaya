import Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentConfig } from '@/server/agent/config';
import { createAgent } from '@/server/agent/run';
import { contextualChips } from '@/server/chat/chips';
import { ensureConversation } from '@/server/chat/conversation';
import { launcherState } from '@/server/chat/launcher';
import { openingFor } from '@/server/chat/opening';
import { pickerOptions } from '@/server/chat/pickers';
import { allowMessage, resetMessageLimits } from '@/server/chat/rate-limit';
import { submitAndFollow } from '@/server/chat/submit';
import { conversations, pendingActions, registry, runTool } from '@/server/tools';
import { startStub, say, type Stub } from './helpers/anthropic-stub';
import { prisma, resetDb } from './helpers/db';
import { ok, owner, save, seedSettings, storekeeper } from './helpers/tools';

let stub: Stub | undefined;
beforeEach(async () => { await resetDb(); await seedSettings(); resetMessageLimits(); });
afterEach(async () => { await stub?.close(); stub = undefined; });
afterAll(() => prisma.$disconnect());

const has = (t: string) => registry.get(t) !== undefined;

describe('the opening card is drawn by read tools', () => {
  it('owner: nothing waiting, nothing low (INTERFACE §4, ACCEPTANCE 21.2)', async () => {
    const o = await owner();
    const { card, badges } = await openingFor(o);
    expect(card).toMatchObject({ kind: 'opening', lines: [{ text: 'Nothing is waiting for you.' }, { text: 'Nothing is below its minimum.' }] });
    expect(badges).toEqual({ pendingApprovals: 0, belowMinimum: 0 });
  });

  it('shows how many are low, with the question that answers it', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_material', { name: 'Ferrite Core E-30', uom: 'NOS', stockType: 'STANDING', minimumLevel: 50 }));
    await ok(save(s, 'create_material', { name: 'Bobbin type-B', uom: 'NOS', stockType: 'STANDING', minimumLevel: 100 }));
    const { card, badges } = await openingFor(s);
    expect(card).toMatchObject({ lines: [{ text: '2 below minimum', ask: 'What is below its minimum level?' }] });
    expect(badges.belowMinimum).toBe(2);
    expect(JSON.stringify(card)).not.toMatch(/Waiting for me|waiting for you/i); // owner only
  });

  it('owner: a count waiting for him shows with the question that answers it', async () => {
    const o = await owner();
    const count = await prisma.stockCount.create({ data: { number: 'CNT-2627-0001', countDate: new Date(), isOpening: true } });
    await prisma.stockCount.update({ where: { id: count.id }, data: { status: 'PENDING_APPROVAL' } }).catch(() => null); // no lines yet: allowed
    const { card } = await openingFor(o);
    expect(card).toMatchObject({ lines: [
      { text: '1 waiting for you', ask: 'What is waiting for my approval?' },
      { text: expect.stringContaining('Opening count CNT-2627-0001'), form: 'approve_stock_count', button: 'Review it' }, // one tap opens the approval
      { text: 'Nothing is below its minimum.' },
    ] });
  });
});

describe('starting a chat', () => {
  it('a new chat begins with the opening card as its first line; a chat is only ever its owner\'s', async () => {
    const a = await storekeeper();
    const b = await owner();
    const c = await ensureConversation(a, null);
    expect(c).toMatchObject({ created: true });
    const items = await conversations.items(a.userId, (c as { id: string }).id);
    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({ role: 'card', card: { kind: 'opening' } });
    expect(await ensureConversation(a, (c as { id: string }).id)).toEqual({ id: (c as { id: string }).id, created: false });
    expect(await ensureConversation(b, (c as { id: string }).id)).toBeNull();
    expect(await ensureConversation(a, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('lists recent chats by their first words, newest first, for that person only', async () => {
    const a = await storekeeper();
    const b = await owner();
    const one = await conversations.create(a.userId);
    await conversations.setTitleIfEmpty(one.id, 'How much wire do we have?');
    await new Promise((r) => setTimeout(r, 15));
    const two = await conversations.create(a.userId);
    await conversations.setTitleIfEmpty(two.id, '  Add   Ferrite Core\nE-30  ');
    await conversations.create(b.userId);
    expect((await conversations.recent(a.userId)).map((c) => c.title)).toEqual(['Add Ferrite Core E-30', 'How much wire do we have?']);
    await conversations.setTitleIfEmpty(two.id, 'later words'); // the first words stay
    expect((await conversations.recent(a.userId))[0]?.title).toBe('Add Ferrite Core E-30');
  });
});

describe('the buttons above the input', () => {
  it('storekeeper: his own buttons, no owner chips; forms stay off until their tools exist; receiving, counting, purchase orders and jobs are on (21.3)', async () => {
    const s = await storekeeper();
    const st = await launcherState(s, true);
    expect(st.launcher.forms.map((f) => f.label)).toEqual(['Receive stock', 'Issue to a job', 'Return', 'Count stock']);
    expect(st.launcher.moreForms.map((f) => f.label)).toEqual(['New PO', 'New job']);
    const chips = [...st.launcher.chips, ...st.launcher.moreChips].map((c) => c.label);
    expect(chips).toEqual(['Low stock', 'Open jobs', 'Stock today']);
    expect(st.formEnabled).toEqual({ record_goods_receipt: true, issue_material: false, return_material: false, start_stock_count: true, create_purchase_order: true, create_job: true });
    expect(st.chipEnabled).toEqual({ 'Low stock': true, 'Open jobs': true, 'Stock today': true });
  });

  it('owner: gets Waiting for me, with Stock value behind More; those that need unbuilt tools stay off', async () => {
    const st = await launcherState(await owner(), true);
    expect(st.launcher.chips.map((c) => c.label)).toEqual(['Waiting for me', 'Low stock', 'Open jobs', 'Stock today']);
    expect(st.launcher.moreChips.map((c) => c.label)).toEqual(['Stock value']);
    expect(st.chipEnabled['Waiting for me']).toBe(true);
    expect(st.chipEnabled['Stock value']).toBe(false);
  });

  it('with the assistant off every chip is off — the form buttons are not affected by it', async () => {
    const st = await launcherState(await storekeeper(), false);
    expect(Object.values(st.chipEnabled).every((v) => v === false)).toBe(true);
    expect(Object.keys(st.formEnabled)).toHaveLength(6);
  });

  it("each person's own use reorders their buttons — counted from the record (21.40–21.43)", async () => {
    const s = await storekeeper();
    const other = await owner();
    const audit = (actorId: string, toolName: string, n: number) =>
      prisma.auditEvent.createMany({ data: Array.from({ length: n }, () => ({ entityType: 'X', entityId: 'x', action: 'CREATE', actorType: 'HUMAN' as const, actorId, toolName, openedFrom: 'LAUNCHER' as const })) });
    await audit(s.userId, 'create_purchase_order', 6);
    await audit(s.userId, 'record_goods_receipt', 2);
    await audit(other.userId, 'create_job', 50); // someone else's use is not mine
    // a form opened by the assistant or in chat does not count as a button press
    await prisma.auditEvent.createMany({ data: Array.from({ length: 20 }, () => ({ entityType: 'X', entityId: 'x', action: 'CREATE', actorType: 'HUMAN' as const, actorId: s.userId, toolName: 'create_job', openedFrom: 'AGENT' as const })) });
    const st = await launcherState(s, true);
    expect(st.launcher.forms.map((f) => f.label)).toEqual(['New PO', 'Receive stock', 'Issue to a job', 'Return']);
    expect(st.launcher.moreForms.map((f) => f.label)).toEqual(['Count stock', 'New job']);
    expect((await launcherState(other, true)).launcher.forms[0]?.label).toBe('New job');
  });

  it('chip taps are counted too, and an owner-only tap by a storekeeper is ignored', async () => {
    const o = await owner();
    const conv = await conversations.create(o.userId);
    for (let i = 0; i < 5; i++) await conversations.append(conv.id, 'USER', { kind: 'text', text: 'Make a stock value report.', chip: 'Stock value' });
    await conversations.append(conv.id, 'USER', { kind: 'text', text: 'What is below its minimum level?', chip: 'Low stock' });
    expect((await launcherState(o, true)).launcher.chips[0]?.label).toBe('Stock value');

    const s = await storekeeper();
    const c2 = await conversations.create(s.userId);
    for (let i = 0; i < 9; i++) await conversations.append(c2.id, 'USER', { kind: 'text', text: 'x', chip: 'Stock value' });
    const st = await launcherState(s, true);
    expect([...st.launcher.chips, ...st.launcher.moreChips].map((c) => c.label)).not.toContain('Stock value');
  });
});

describe('contextual chips after an answer', () => {
  it('2–3 questions that fit what just happened, never the one just asked, never a form', () => {
    const chips = contextualChips('STOREKEEPER', ['search_materials'], 'What is below its minimum level?', has);
    expect(chips.length).toBeLessThanOrEqual(3);
    expect(chips.map((c) => c.label)).toEqual(['Stock today', 'Open jobs']); // Low stock was just asked
    for (const c of chips) expect(c).toHaveProperty('ask');
  });
  it('is never blank, and never offers owner questions to the storekeeper', () => {
    const sk = contextualChips('STOREKEEPER', [], '', has);
    expect(sk.map((c) => c.label)).toEqual(['Low stock', 'Open jobs', 'Stock today']);
    const ow = contextualChips('OWNER', ['list_reorder_alerts'], '', has);
    expect(ow.map((c) => c.label)).toEqual(['Stock today', 'Open jobs', 'Waiting for me']);
    expect(ow.length).toBeGreaterThanOrEqual(2);
  });
});

describe('saving a form: the server draws the "Saved" card', () => {
  async function proposed() {
    const s = await storekeeper();
    const conv = await conversations.create(s.userId);
    const f = await pendingActions.create(s, { tool: 'create_material', origin: 'AGENT', conversationId: conv.id, input: { name: 'Ferrite Core E-30' } });
    if (!f.ok) throw new Error(f.message);
    return { s, conv, pendingId: f.data.id };
  }

  it('stamp and lines come from the audit row; the assistant is told what was saved; nothing is claimed in model words', async () => {
    const { s, conv, pendingId } = await proposed();
    const r = await submitAndFollow(s, pendingId, { name: 'Ferrite Core E-30', uom: 'NOS', stockType: 'STANDING', minimumLevel: 50 });
    expect(r).toMatchObject({ ok: true, items: [{ role: 'card', card: { kind: 'saved', stamp: 'MATERIAL ADDED', lines: ['Ferrite Core E-30', 'Unit: pieces', 'Kept in stock, minimum 50 pcs'] } }] });
    const items = await conversations.items(s.userId, conv.id);
    expect(items?.map((i) => (i.role === 'card' ? i.card.kind : i.role))).toEqual(['saved']);
    const rows = await conversations.rows(conv.id);
    expect(JSON.stringify(rows.at(-1)?.content)).toContain('The user saved this (the system recorded it): material added');
    const savedAudit = await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'create_material' } });
    expect((r as { items: { card: { auditId: string } }[] }).items[0]?.card.auditId).toBe(savedAudit.id);
  });

  it('a mistake keeps the form open, with the message next to its box; fixing it then works once', async () => {
    const { s, pendingId } = await proposed();
    const bad = await submitAndFollow(s, pendingId, { name: 'Ferrite Core E-30', uom: 'NOS', stockType: 'STANDING' });
    expect(bad).toMatchObject({ ok: false, code: 'MINIMUM_REQUIRED', field: 'minimumLevel', message: 'Material kept in stock needs a minimum level.' });
    expect(await prisma.material.count()).toBe(0);
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: pendingId } })).status).toBe('OPEN');
    expect((await submitAndFollow(s, pendingId, { name: 'Ferrite Core E-30', uom: 'NOS', stockType: 'STANDING', minimumLevel: 50 })).ok).toBe(true);
    expect(await submitAndFollow(s, pendingId, { name: 'Ferrite Core E-30', uom: 'NOS', stockType: 'STANDING', minimumLevel: 50 })).toMatchObject({ ok: false, code: 'ALREADY_SUBMITTED' });
    expect(await prisma.material.count()).toBe(1);
  });

  it('a similar name comes back as a question with names only (so the form can offer "this is a different one")', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_material', { name: '22 SWG Copper Wire', uom: 'KG', stockType: 'PER_JOB' }));
    const f = await pendingActions.create(s, { tool: 'create_material', origin: 'LAUNCHER' });
    if (!f.ok) throw new Error('setup');
    const r = await submitAndFollow(s, f.data.id, { name: 'Copper Wire 22 SWG', uom: 'KG', stockType: 'PER_JOB' });
    expect(r).toMatchObject({ ok: false, code: 'SIMILAR_MATERIAL_EXISTS', details: { matches: [{ name: '22 SWG Copper Wire', unit: 'kg' }] } });
    expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|MAT-/);
  });

  it("someone else's form cannot be saved", async () => {
    const { pendingId } = await proposed();
    const intruder = await owner();
    expect(await submitAndFollow(intruder, pendingId, { name: 'x', uom: 'KG', stockType: 'PER_JOB' })).toMatchObject({ ok: false, code: 'CONFIRMATION_INVALID' });
  });

  it('adding a role to a business that already exists is stamped as a change, not as an addition', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_party', { name: 'Ashok Transformers', role: 'CUSTOMER' }));
    const f = await pendingActions.create(s, { tool: 'create_party', origin: 'LAUNCHER' });
    if (!f.ok) throw new Error('setup');
    const r = await submitAndFollow(s, f.data.id, { name: 'Ashok Transformers', role: 'SUPPLIER' });
    expect(r).toMatchObject({ ok: true, items: [{ card: { stamp: 'ROLE ADDED', lines: ['Ashok Transformers', 'Supplier and customer'] } }] });
  });
});

describe('the sentence after a save (follow-up)', () => {
  async function agentWith(script: Parameters<typeof startStub>[0], over = {}) {
    stub = await startStub(script);
    return createAgent({ registry, runTool, pending: pendingActions, store: conversations, config: { ...agentConfig({ NODE_ENV: 'test' }), apiKey: 'k', ...over }, client: new Anthropic({ apiKey: 'k', baseURL: stub.url, maxRetries: 0 }) });
  }

  it('is one or two plain sentences, written with no tools to call, and kept in the chat', async () => {
    const agent = await agentWith(() => say('Copper wire is now below its minimum. The owner has been told.'));
    const s = await storekeeper();
    const conv = await conversations.create(s.userId);
    const text = await agent.followUp(s, conv.id, ['22 SWG Copper Wire is now 3 kg, below its minimum of 50 kg.']);
    expect(text).toBe('Copper wire is now below its minimum. The owner has been told.');
    const body = (stub as Stub).requests[0]?.body as Record<string, unknown>;
    expect(body.tools).toBeUndefined(); // it can only talk
    expect((stub as Stub).requests[0]?.userText).toContain('22 SWG Copper Wire is now 3 kg');
    expect((await conversations.rows(conv.id)).map((r) => r.role)).toEqual(['USER', 'ASSISTANT']);
    expect((await prisma.agentRun.findFirstOrThrow()).status).toBe('DONE');
  });

  it('says nothing when there is nothing to say, when the assistant is off, or when it fails', async () => {
    const s = await storekeeper();
    const conv = await conversations.create(s.userId);
    const agent = await agentWith(() => ({ httpError: 529 }));
    expect(await agent.followUp(s, conv.id, [])).toBeNull();
    expect((stub as Stub).requests).toHaveLength(0);
    expect(await agent.followUp(s, conv.id, ['a fact'])).toBeNull(); // the API is down: a failed follow-up shows nothing extra
    const off = await agentWith(() => say('never'), { enabled: false });
    expect(await off.followUp(s, conv.id, ['a fact'])).toBeNull();
    expect((stub as Stub).requests).toHaveLength(0);
  });
});

describe('type-ahead in forms', () => {
  it('finds a material however it is typed, shows a name and a unit, never a code (21.21)', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_material', { name: 'Ferrite Core E-30', uom: 'NOS', stockType: 'PER_JOB' }));
    const r = await pickerOptions(s, 'material', 'ferite core e30');
    expect(r).toEqual([{ id: expect.any(String), label: 'Ferrite Core E-30', secondary: 'pcs', unit: 'NOS' }]);
    expect(JSON.stringify(r)).not.toMatch(/MAT-/);
  });
  it('a party is picked, not typed: name, type and city', async () => {
    const s = await storekeeper();
    await ok(save(s, 'create_party', { name: 'Sundaram Ferrites', role: 'SUPPLIER', city: 'Chennai' }));
    await ok(save(s, 'create_party', { name: 'Ashok Transformers', role: 'CUSTOMER' }));
    expect(await pickerOptions(s, 'party', 'sundaram')).toMatchObject([{ label: 'Sundaram Ferrites', secondary: 'Supplier · Chennai' }]);
    expect((await pickerOptions(s, 'party', '', { role: 'CUSTOMER' })).map((p) => p.label)).toEqual(['Ashok Transformers']);
  });
  it('only the owner can look people up', async () => {
    const o = await owner();
    const s = await storekeeper();
    expect((await pickerOptions(o, 'user', '')).length).toBeGreaterThan(0);
    expect(await pickerOptions(s, 'user', '')).toEqual([]);
  });
});

describe('sending too fast', () => {
  it('allows a steady 20 a minute and then asks the person to wait', () => {
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) expect(allowMessage('u1', 20, t + i)).toBe(true);
    expect(allowMessage('u1', 20, t + 30)).toBe(false);
    expect(allowMessage('u2', 20, t + 30)).toBe(true); // not shared between people
    expect(allowMessage('u1', 20, t + 61_000)).toBe(true); // a minute later
  });
});
