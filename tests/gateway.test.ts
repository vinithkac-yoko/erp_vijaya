import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import descriptions from '../prompts/tool-descriptions.json';
import { defineTool } from '@/server/tools/define';
import { Registry } from '@/server/tools/registry';
import { registry as productionRegistry } from '@/server/tools';
import { createRunTool } from '@/server/tools/run-tool';
import { expectPlain, prisma, resetDb } from './helpers/db';
import { openForm, registry, resetSeen, runTool, seen, session } from './helpers/gateway';

beforeEach(async () => { await resetDb(); resetSeen(); });
afterAll(() => prisma.$disconnect());

const material = { name: 'Ferrite Core E-30', uom: 'NOS' };
const count = () => prisma.material.count();
const audits = () => prisma.auditEvent.findMany({ orderBy: { createdAt: 'asc' } });

describe('defineTool — a tool that disagrees with the catalog never starts', () => {
  const noop = async () => ({ data: {}, audit: { entityType: 'x', entityId: 'x', action: 'CREATE' } });
  it('refuses a name that is not in the catalog (no list_rows, no register)', () => {
    for (const name of ['list_rows', 'register', 'whoami'])
      expect(() => defineTool({ name, kind: 'read', roles: ['OWNER'], input: z.object({}), handler: async () => ({}) })).toThrow(/not in the catalog/);
  });
  it('refuses missing roles, the wrong kind, and roles that differ from the catalog', () => {
    expect(() => defineTool({ name: 'create_material', kind: 'write', roles: [], input: z.object({}), handler: noop })).toThrow(/must declare its roles/);
    expect(() => defineTool({ name: 'create_material', kind: 'read', roles: ['OWNER', 'STOREKEEPER'], input: z.object({}), handler: async () => ({}) })).toThrow(/catalog/);
    expect(() => defineTool({ name: 'create_user', kind: 'write', roles: ['OWNER', 'STOREKEEPER'], input: z.object({}), handler: noop })).toThrow(/roles/);
  });
  it('takes the model-facing text from prompts/tool-descriptions.json, never from the caller', () => {
    const t = registry.get('create_material');
    expect(t?.description).toBe((descriptions as { tools: Record<string, { description: string }> }).tools.create_material?.description);
    expect(t?.description.length).toBeGreaterThan(20);
  });
  it('a tool cannot be registered twice', () => {
    const t = registry.get('list_jobs');
    expect(() => new Registry([t as never, t as never])).toThrow(/twice/);
  });
});

describe('who may call what', () => {
  it('an unknown tool is refused without naming what exists', async () => {
    const s = await session();
    for (const name of ['list_rows', 'register', 'DROP TABLE users', '']) {
      const r = await runTool(s, name, {});
      expect(r).toEqual({ ok: false, code: 'UNKNOWN_TOOL', message: "I can't do that." });
    }
  });

  it('role comes from the session: a storekeeper cannot run an owner tool, and the handler is never reached', async () => {
    const s = await session('STOREKEEPER');
    const form = await openForm(await session('OWNER'), 'create_user').catch(() => '');
    expect(form).not.toBe('');
    const r = await runTool(s, 'create_user', { name: 'Ravi', login: 'ravi@x.local', role: 'OWNER' }, { confirmation: form });
    expect(r).toEqual({ ok: false, code: 'FORBIDDEN_ROLE', message: 'Only the owner can do that.' });
    expect(seen.createUser).toBe(0);
  });

  it('claims in the input about who is asking change nothing', async () => {
    const s = await session('STOREKEEPER');
    const r = await runTool(s, 'create_user', { name: 'Ravi', login: 'ravi@x.local', role: 'OWNER', asRole: 'OWNER', session: { role: 'OWNER' } });
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN_ROLE' });
  });

  it("the assistant is only offered its role's tools: a storekeeper's list has no owner tool", () => {
    const names = registry.forRole('STOREKEEPER').map((t) => t.name);
    expect(names).toContain('create_material');
    expect(names).not.toContain('create_user');
    expect(registry.forRole('OWNER').map((t) => t.name)).toContain('create_user');
  });

  it('every tool in the production registry declares roles, matches the catalog and has text', () => {
    for (const t of productionRegistry.list()) {
      expect(t.roles.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(10);
    }
  });
});

describe('input', () => {
  it('unknown keys are stripped before the handler sees them', async () => {
    const s = await session();
    const form = await openForm(s, 'create_material');
    const r = await runTool(s, 'create_material', { ...material, role: 'OWNER', isActive: false, id: 'forced-id', __proto__: { admin: true } }, { confirmation: form });
    expect(r.ok).toBe(true);
    expect(seen.createMaterial).toEqual([material]);
  });

  it('bad input is refused in plain words, before anything is touched', async () => {
    const s = await session();
    const form = await openForm(s, 'create_material');
    expect(await runTool(s, 'create_material', { name: '', uom: 'NOS' }, { confirmation: form })).toEqual({ ok: false, code: 'INVALID_INPUT', message: 'Type the name.' });
    expect(await runTool(s, 'create_material', 'not an object', { confirmation: form })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await runTool(s, 'create_material', { name: 'x', uom: 'BAGS' }, { confirmation: form })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await count()).toBe(0);
    // the form is still open: a typo does not burn it
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: form } })).status).toBe('OPEN');
  });
});

describe('reads', () => {
  it('run at once, need no form, and write no audit entry', async () => {
    const s = await session();
    expect(await runTool(s, 'list_jobs', {})).toEqual({ ok: true, data: { jobs: 0 } });
    expect(seen.listJobs).toBe(1);
    expect(await audits()).toEqual([]);
  });
});

describe('writes need a form this person submitted', () => {
  it('no confirmation → nothing happens', async () => {
    const s = await session();
    const r = await runTool(s, 'create_material', material);
    expect(r).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    expect(seen.createMaterial).toEqual([]);
    expect(await count()).toBe(0);
  });

  it('a made-up or empty confirmation is refused', async () => {
    const s = await session();
    for (const confirmation of ['nope', '', 'yes', '00000000-0000-0000-0000-000000000000'])
      expect(await runTool(s, 'create_material', material, { confirmation })).toMatchObject({ ok: false });
    expect(await count()).toBe(0);
  });

  it('a submitted form writes once, with one audit event that says who, how and what', async () => {
    const s = await session();
    const form = await openForm(s, 'create_material', 'LAUNCHER');
    const r = await runTool(s, 'create_material', material, { confirmation: form });
    expect(r).toMatchObject({ ok: true, data: { name: 'Ferrite Core E-30' } });
    expect(await count()).toBe(1);

    const [ev, ...rest] = await audits();
    expect(rest).toEqual([]);
    expect(ev).toMatchObject({
      entityType: 'Material', action: 'CREATE', actorType: 'HUMAN', actorId: s.userId, toolName: 'create_material',
      openedFrom: 'LAUNCHER', pendingActionId: form, agentRunId: null,
    });
    expect(ev?.afterJson).toEqual({ name: 'Ferrite Core E-30', uom: 'NOS' });
    expect((r as { auditId: string }).auditId).toBe(ev?.id); // the server draws the "Saved" card from this row
    const pa = await prisma.pendingAction.findUniqueOrThrow({ where: { id: form } });
    expect(pa.status).toBe('SUBMITTED');
    expect(pa.submittedAt).not.toBeNull();
  });

  it('a form the assistant proposed is audited as AGENT, with the run it came from', async () => {
    const s = await session();
    const form = await openForm(s, 'create_material', 'AGENT', { agentRunId: 'run-42', input: material });
    await runTool(s, 'create_material', material, { confirmation: form });
    expect((await audits())[0]).toMatchObject({ actorType: 'AGENT', actorId: s.userId, agentRunId: 'run-42', openedFrom: 'AGENT' });
  });

  it('a form an artifact opened is audited as the person, with the artifact and version', async () => {
    const s = await session();
    const form = await openForm(s, 'create_material', 'ARTIFACT', { artifactId: 'art-1', artifactVersion: 3 });
    await runTool(s, 'create_material', material, { confirmation: form });
    expect((await audits())[0]).toMatchObject({ actorType: 'HUMAN', openedFrom: 'ARTIFACT', artifactId: 'art-1', artifactVersion: 3 });
  });

  it('one-shot: the same form cannot be used twice', async () => {
    const s = await session();
    const form = await openForm(s, 'create_material');
    expect((await runTool(s, 'create_material', material, { confirmation: form })).ok).toBe(true);
    const again = await runTool(s, 'create_material', { name: 'Another', uom: 'KG' }, { confirmation: form });
    expect(again).toMatchObject({ ok: false, code: 'ALREADY_SUBMITTED' });
    expect(await count()).toBe(1);
  });

  it("a stale 'ok' three turns later cannot run an old change: a newer form replaces it", async () => {
    const s = await session();
    const old = await openForm(s, 'create_material');
    const fresh = await openForm(s, 'create_material');
    expect(await runTool(s, 'create_material', material, { confirmation: old })).toMatchObject({ ok: false, code: 'FORM_CLOSED' });
    expect((await runTool(s, 'create_material', material, { confirmation: fresh })).ok).toBe(true);
  });

  it("someone else's form, or a form for another tool, is refused — and the message does not say which", async () => {
    const mine = await session('OWNER');
    const theirs = await session('STOREKEEPER');
    const hisForm = await openForm(theirs, 'create_material');
    const a = await runTool(mine, 'create_material', material, { confirmation: hisForm });
    const b = await runTool(theirs, 'issue_material', { materialId: 'm', quantity: 1 }, { confirmation: hisForm });
    const c = await runTool(theirs, 'create_material', material, { confirmation: 'does-not-exist' });
    for (const r of [a, b, c]) expect(r).toMatchObject({ ok: false, code: 'CONFIRMATION_INVALID' });
    expect(await count()).toBe(0);
    // and his form is still his
    expect((await runTool(theirs, 'create_material', material, { confirmation: hisForm })).ok).toBe(true);
  });

  it('a form expires after 15 minutes', async () => {
    const s = await session();
    const form = await openForm(s, 'create_material');
    await prisma.pendingAction.update({ where: { id: form }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await runTool(s, 'create_material', material, { confirmation: form });
    expect(r).toMatchObject({ ok: false, code: 'PENDING_EXPIRED' });
    expectPlain(r as { code: string; message: string });
    expect(await count()).toBe(0);
  });

  it('a closed ("Not now") form cannot be submitted', async () => {
    const s = await session();
    const form = await openForm(s, 'create_material');
    await prisma.pendingAction.update({ where: { id: form }, data: { status: 'CANCELLED' } });
    expect(await runTool(s, 'create_material', material, { confirmation: form })).toMatchObject({ ok: false, code: 'FORM_CLOSED' });
  });

  it('a double click or a second tab: exactly one wins', async () => {
    const s = await session();
    const form = await openForm(s, 'create_material');
    const results = await Promise.all(Array.from({ length: 8 }, () => runTool(s, 'create_material', material, { confirmation: form })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'ALREADY_SUBMITTED')).toBe(true);
    expect(await count()).toBe(1);
    expect(await audits()).toHaveLength(1);
  });
});

describe('one transaction: if anything fails, nothing is kept', () => {
  it('a business error half-way rolls back the writes AND leaves the form open to try again', async () => {
    const s = await session();
    const form = await openForm(s, 'cancel_job');
    const r = await runTool(s, 'cancel_job', { jobId: 'j', reason: 'r' }, { confirmation: form });
    expect(r).toEqual({ ok: false, code: 'JOB_NOT_FOUND', message: "Couldn't find that job." });
    expect(await count()).toBe(0);
    expect(await audits()).toEqual([]);
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: form } })).status).toBe('OPEN');
  });

  it('a database refusal is turned into plain words, and also rolls everything back', async () => {
    const s = await session();
    const m = await prisma.material.create({ data: { code: 'MAT-1', name: 'Wire', nameKey: 'wire', uom: 'KG', stockType: 'PER_JOB' } });
    const form = await openForm(s, 'issue_material');
    const r = await runTool(s, 'issue_material', { materialId: m.id, quantity: 0 }, { confirmation: form });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_QUANTITY', message: 'The quantity must be more than zero.' });
    expectPlain(r as { code: string; message: string });
    expect(await prisma.stockMovement.count()).toBe(0);
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: form } })).status).toBe('OPEN');
  });

  it('a write that returns no audit entry is refused: every write has one', async () => {
    const s = await session();
    const m = await prisma.material.create({ data: { code: 'MAT-2', name: 'Tape', nameKey: 'tape', uom: 'MTR', stockType: 'PER_JOB' } });
    const form = await openForm(s, 'deactivate_material');
    const r = await runTool(s, 'deactivate_material', { materialId: m.id }, { confirmation: form });
    expect(r).toMatchObject({ ok: false, code: 'INTERNAL' });
    expect((await prisma.material.findUniqueOrThrow({ where: { id: m.id } })).isActive).toBe(true); // rolled back
    expect(await audits()).toEqual([]);
  });

  it('never throws at the caller, even when the database is gone — and never names the host', async () => {
    const dead = new PrismaClient({ datasourceUrl: 'postgresql://nobody:secretpw@db.internal.example:1/none?connect_timeout=2' });
    const run = createRunTool(registry, dead);
    const s = await session();
    const read = await run(s, 'list_jobs', {});
    const write = await run(s, 'create_material', material, { confirmation: 'any' });
    for (const r of [read, write]) {
      expect(r).toMatchObject({ ok: false, code: 'INTERNAL' });
      expect(JSON.stringify(r)).not.toMatch(/secretpw|internal\.example|nobody|connect/i);
    }
    await dead.$disconnect();
  }, 30_000);
});

describe('secrets never reach the audit log (SAFETY T19)', () => {
  it('password, hash and keys are replaced, at any depth', async () => {
    const owner = await session('OWNER');
    const form = await openForm(owner, 'create_user');
    const r = await runTool(owner, 'create_user', { name: 'Ravi', login: 'ravi@x.local', role: 'STOREKEEPER', password: 'correct-horse-9' }, { confirmation: form });
    expect(r.ok).toBe(true);
    const ev = (await audits())[0];
    expect(ev?.afterJson).toEqual({ name: 'Ravi', passwordHash: '[hidden]', password: '[hidden]', nested: { apiKey: '[hidden]', ok: 1 } });
    expect(JSON.stringify(ev)).not.toMatch(/correct-horse|hashed:|sk-live/);
  });
});
