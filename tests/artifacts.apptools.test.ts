import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/server/db';
import { conversations, runTool } from '@/server/tools';
import { runAppTool, appToolDefs, type AppToolContext } from '@/server/artifacts/app-tools';
import * as store from '@/server/artifacts/store';
import type { BuilderModel } from '@/server/artifacts/builder';
import { makeJob, makeMaterial, makeParty, prisma, resetDb } from './helpers/db';
import { owner, seedSettings, storekeeper } from './helpers/tools';

beforeEach(async () => { await resetDb(); await seedSettings(); });
afterAll(() => prisma.$disconnect());

const GOOD = `---\ntitle: Below minimum\nreads:\n  alerts: list_reorder_alerts {}\n---\n**{{alerts.count}}** materials are below their minimum level.\n\n\`\`\`vtable\n{"from":"alerts","columns":[{"field":"material","label":"Material"}]}\n\`\`\`\n`;
const NO_TABLE = `---\ntitle: How we receive\n---\n1. Check the challan.\n`;
const PAGE = `<script>(async () => { const r = await vijaya.read('list_reorder_alerts', {}); vijaya.ui.heading('Low'); vijaya.ui.table({ columns: [{ field: 'material', label: 'Material' }], rows: r.rows }); })();</script>`;

function builder(answers: Record<string, unknown>[]): BuilderModel {
  let n = 0;
  const client = { messages: { stream: (p: { tool_choice: { name: string } }) => ({ finalMessage: async () => ({ content: [{ type: 'tool_use', id: `t${n}`, name: p.tool_choice.name, input: answers[Math.min(n++, answers.length - 1)] }], usage: { input_tokens: 10, output_tokens: 5 } }) }) } } as unknown as Anthropic;
  return { client, model: 'test', effort: 'low' };
}
const ctx = async (who: 'OWNER' | 'STOREKEEPER', over: Partial<AppToolContext> = {}): Promise<AppToolContext> => {
  const session = who === 'OWNER' ? await owner() : await storekeeper();
  const conv = await conversations.create(session.userId);
  return { session, conversationId: conv.id, runId: 'r', userTexts: ['make me a report of low stock'], builder: builder([{ kind: 'document', title: 'x', source: GOOD }]), runTool, now: new Date(), ...over };
};
const body = (r: { text: string }) => JSON.parse(r.text) as Record<string, unknown>;
const mk = (ownerId: string, kind: 'document' | 'page', source: string, title = 'A report') => store.createArtifact(db, { ownerId, kind, title, source, request: 'x', checkReport: {} });

describe('which artifact tools each role is offered', () => {
  it('both roles get the same six, with the words from the generated file', () => {
    for (const role of ['OWNER', 'STOREKEEPER'] as const) {
      expect(appToolDefs(role).map((t) => t.name)).toEqual(['list_artifacts', 'open_artifact', 'make_artifact', 'edit_artifact', 'open_printout', 'download_data']);
    }
    expect(appToolDefs('OWNER').find((t) => t.name === 'make_artifact')?.description).toMatch(/ONLY when the user asks for a report/);
  });
});

describe('make_artifact (ARTIFACTS §2, §3)', () => {
  it('builds it, stores version 1 with the checker\'s report, audits it as the assistant\'s, and puts a card in the chat', async () => {
    const c = await ctx('STOREKEEPER');
    const r = await runAppTool('make_artifact', c, { request: 'materials below minimum' });
    expect(r.isError).toBeUndefined();
    expect(body(r)).toMatchObject({ title: 'Below minimum', kind: 'document', version: 1 });
    expect(r.cards).toMatchObject([{ kind: 'artifact', title: 'Below minimum', version: 1, artifactKind: 'document', open: true }]);
    expect(r.usage).toEqual({ input: 10, output: 5 });
    const v = await prisma.artifactVersion.findFirstOrThrow();
    expect(v.checkReport).toMatchObject({ ok: true, reads: ['list_reorder_alerts'] });
    const a = await prisma.auditEvent.findFirstOrThrow({ where: { entityType: 'Artifact' } });
    expect(a).toMatchObject({ action: 'CREATE', toolName: 'make_artifact', actorType: 'AGENT', openedFrom: 'AGENT' });
  });

  it('is refused when nobody asked for a report, chart, document or what-if: a fact is a sentence', async () => {
    const c = await ctx('OWNER', { userTexts: ['how much copper wire do we have?', 'and tape?'] });
    const r = await runAppTool('make_artifact', c, { request: 'copper wire stock' });
    expect(r.isError).toBe(true);
    expect(body(r).error).toMatch(/Nobody asked/);
    expect(await prisma.artifact.count()).toBe(0);
    // …but the ask can have come a message earlier ("make it", "yes")
    const later = await ctx('OWNER', { userTexts: ['I want a report on low stock', 'yes please'] });
    expect((await runAppTool('make_artifact', later, { request: 'low stock' })).isError).toBeUndefined();
  });

  it('twenty an hour is the most (the cost guard); the twenty-first is refused in plain words', async () => {
    const c = await ctx('OWNER');
    for (let i = 0; i < 20; i++) await mk(c.session.userId, 'document', GOOD, `n${i}`);
    const r = await runAppTool('make_artifact', c, { request: 'low stock' });
    expect(r.isError).toBe(true);
    expect(body(r).error).toMatch(/20 made in the last hour/);
    expect(await prisma.artifact.count()).toBe(20);
  });

  it('a builder that never passes the checks makes nothing, and the assistant is told to show a table instead', async () => {
    const bad = `---\ntitle: Bad\nreads:\n  a: list_reorder_alerts {}\n---\nWe have ₹5,000 and {{a.count}}.\n`;
    const c = await ctx('OWNER', { builder: builder([{ kind: 'document', title: 'x', source: bad }]) });
    const r = await runAppTool('make_artifact', c, { request: 'low stock report' });
    expect(r.isError).toBe(true);
    expect(body(r).error).toMatch(/couldn't build that/i);
    expect(body(r).error).toMatch(/nearest table/);
    expect(await prisma.artifact.count()).toBe(0);
  });

  it('with the assistant off there is no builder, and it says so', async () => {
    const r = await runAppTool('make_artifact', await ctx('OWNER', { builder: null }), { request: 'low stock report' });
    expect(r.isError).toBe(true);
  });

  it('refuses a request that is too short, and a kind that does not exist', async () => {
    const c = await ctx('OWNER');
    expect((await runAppTool('make_artifact', c, { request: 'hi' })).isError).toBe(true);
    expect((await runAppTool('make_artifact', c, { request: 'a report on stock', kind: 'screen' })).isError).toBe(true);
  });
});

describe('edit_artifact, open_artifact, list_artifacts', () => {
  it('edits the one open beside the chat, as a new version; a copy that was shared with him cannot be edited', async () => {
    const o = await ctx('OWNER');
    const a = await mk(o.session.userId, 'document', GOOD);
    const patch = builder([{ patches: [{ old: 'below their minimum level', new: 'short of their minimum' }], summary: 'Reworded it.' }]);
    const r = await runAppTool('edit_artifact', { ...o, openArtifactId: a.artifactId, builder: patch }, { request: 'reword' });
    expect(body(r)).toMatchObject({ version: 2, changed: 'Reworded it.' });
    expect(r.cards).toMatchObject([{ kind: 'artifact', version: 2 }]);

    const him = await storekeeper();
    await db.artifactShare.create({ data: { artifactId: a.artifactId, versionId: (await prisma.artifactVersion.findFirstOrThrow({ where: { n: 2 } })).id, toUserId: him.userId, sharedById: o.session.userId } });
    const sk = await ctx('STOREKEEPER', { session: him });
    const e = await runAppTool('edit_artifact', { ...sk, builder: patch }, { artifactId: a.artifactId, request: 'reword' });
    expect(e.isError).toBe(true);
    expect(body(e).error).toMatch(/shared with this person/);
    expect(await prisma.artifactVersion.count()).toBe(2);
  });

  it('asks which one when none is open and none is named', async () => {
    const r = await runAppTool('edit_artifact', await ctx('OWNER'), { request: 'reword it' });
    expect(r.isError).toBe(true);
    expect(body(r).error).toMatch(/Which artifact/);
  });

  it('open_artifact opens mine or one shared with me, and says "couldn\'t find" for anybody else\'s', async () => {
    const o = await ctx('OWNER'); const s = await ctx('STOREKEEPER');
    const a = await mk(o.session.userId, 'document', GOOD);
    expect((await runAppTool('open_artifact', o, { artifactId: a.artifactId })).cards).toMatchObject([{ kind: 'artifact', title: 'A report' }]);
    const stranger = await runAppTool('open_artifact', s, { artifactId: a.artifactId });
    expect(stranger.isError).toBe(true);
    expect(body(stranger).error).toBe("Couldn't find that artifact.");
  });

  it('list_artifacts finds by words in the title and shows the person\'s own and what was shared with them', async () => {
    const o = await ctx('OWNER');
    await mk(o.session.userId, 'document', GOOD, 'Copper rates');
    await mk(o.session.userId, 'document', GOOD, 'Below minimum');
    const r = body(await runAppTool('list_artifacts', o, { query: 'copper' })) as { mine: { title: string }[]; sharedWithMe: unknown[] };
    expect(r.mine.map((x) => x.title)).toEqual(['Copper rates']);
    expect(r.sharedWithMe).toEqual([]);
  });
});

describe('open_printout (ARTIFACTS §9)', () => {
  async function po() {
    const sup = await makeParty('supplier', { name: 'Sundaram Ferrites' });
    const m = await makeMaterial({ name: 'Ferrite Core E-30', uom: 'NOS' });
    return prisma.purchaseOrder.create({ data: { number: 'PO-2627-0015', supplierId: sup.id, poDate: new Date(), status: 'PENDING_APPROVAL', subTotal: 63830, totalValue: 63830, lines: { create: [{ materialId: m.id, quantity: 982, rate: 65, amount: 63830 }] } } });
  }
  it('opens a printout card for the purchase order, by its number; an unapproved one is said to carry a mark', async () => {
    await po();
    const r = await runAppTool('open_printout', await ctx('STOREKEEPER'), { template: 'purchase-order', with: { purchaseOrder: '15' } });
    expect(r.cards).toMatchObject([{ kind: 'printout', template: 'purchase-order', title: 'Purchase order · PO-2627-0015', open: true }]);
    expect(body(r).note).toMatch(/NOT APPROVED/);
  });
  it('only the five printouts exist: no tax invoice, no delivery challan', async () => {
    for (const t of ['tax-invoice', 'delivery-challan', 'quotation']) {
      const r = await runAppTool('open_printout', await ctx('OWNER'), { template: t, with: {} });
      expect(r.isError).toBe(true);
      expect(body(r).error).toBe(`There is no printout called ${t}.`);
    }
  });
  it('the job cost sheet is the owner\'s: the storekeeper is refused before any data is read', async () => {
    const j = await makeJob();
    const sk = await runAppTool('open_printout', await ctx('STOREKEEPER'), { template: 'job-cost-sheet', with: { job: j.number } });
    expect(sk.isError).toBe(true);
    expect(body(sk).error).toBe('That printout is not available to you.');
    expect((await runAppTool('open_printout', await ctx('OWNER'), { template: 'job-cost-sheet', with: { job: j.number } })).cards).toHaveLength(1);
  });
  it('a missing purchase order is "couldn\'t find", in plain words', async () => {
    const r = await runAppTool('open_printout', await ctx('OWNER'), { template: 'purchase-order', with: { purchaseOrder: '999' } });
    expect(body(r).error).toMatch(/Couldn't find that purchase order/);
  });
});

describe('download_data (ARTIFACTS §10)', () => {
  it('a document: PDF, Word, Excel, CSV, picture or Markdown; the button points at the server, never at rows', async () => {
    const o = await ctx('OWNER');
    const a = await mk(o.session.userId, 'document', GOOD);
    for (const f of ['pdf', 'docx', 'xlsx', 'csv', 'png', 'md']) {
      const r = await runAppTool('download_data', { ...o, openArtifactId: a.artifactId }, { format: f });
      expect(r.cards).toMatchObject([{ kind: 'download', href: `/api/artifacts/${a.artifactId}/download?format=${f}` }]);
    }
  });
  it('a page cannot be Word or Markdown: refused in plain words with what it can be', async () => {
    const o = await ctx('OWNER');
    const a = await mk(o.session.userId, 'page', PAGE);
    for (const f of ['docx', 'md']) {
      const r = await runAppTool('download_data', o, { format: f, artifactId: a.artifactId });
      expect(r.isError).toBe(true);
      expect(body(r).error).toMatch(/A page can't be downloaded as/);
      expect(body(r).error).toMatch(/PDF/);
    }
    expect((await runAppTool('download_data', o, { format: 'pdf', artifactId: a.artifactId })).cards).toHaveLength(1);
  });
  it('a document with no table cannot be Excel or CSV', async () => {
    const o = await ctx('OWNER');
    const a = await mk(o.session.userId, 'document', NO_TABLE, 'How we receive');
    for (const f of ['xlsx', 'csv']) expect((await runAppTool('download_data', o, { format: f, artifactId: a.artifactId })).isError).toBe(true);
    expect((await runAppTool('download_data', o, { format: 'pdf', artifactId: a.artifactId })).isError).toBeUndefined();
  });
  it('a table from the chat is Excel or CSV only, from a read tool this role may use', async () => {
    const o = await ctx('OWNER'); const s = await ctx('STOREKEEPER');
    const ok = await runAppTool('download_data', o, { format: 'xlsx', source: { tool: 'get_stock_value' }, title: 'Stock value' });
    expect(ok.cards).toMatchObject([{ kind: 'download', label: 'Download Excel · Stock value' }]);
    expect(String((ok.cards![0] as { href: string }).href)).toMatch(/^\/api\/download\?tool=get_stock_value&input=%7B%7D&format=xlsx/);
    expect((await runAppTool('download_data', o, { format: 'docx', source: { tool: 'get_stock_value' } })).isError).toBe(true);
    // the storekeeper cannot download an owner table, and a write tool is not a table at all
    expect((await runAppTool('download_data', s, { format: 'xlsx', source: { tool: 'get_stock_value' } })).isError).toBe(true);
    expect((await runAppTool('download_data', o, { format: 'xlsx', source: { tool: 'create_material' } })).isError).toBe(true);
    expect((await runAppTool('download_data', o, { format: 'xlsx', source: { tool: 'get_print_data' } })).isError).toBe(true);
  });
  it('asks which one when nothing is named and nothing is open', async () => {
    expect((await runAppTool('download_data', await ctx('OWNER'), { format: 'pdf' })).isError).toBe(true);
  });
});
