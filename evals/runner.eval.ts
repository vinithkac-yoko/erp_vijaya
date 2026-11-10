/**
 * The agent eval runner (`pnpm eval`), as evals/README.md describes it. For each case: a throwaway database in the
 * case's starting state, a login as the case's role, every turn typed into the same agent the chat endpoint uses, a
 * TurnRecord built from what the agent actually did (not from its words), then `evaluate()`.
 *
 *   LIVE_ANTHROPIC_API_KEY=… pnpm eval                      # every case that can run now, 5 times each
 *   EVAL_RUNS=1 EVAL_ONLY=11.,12. pnpm eval                 # a quick look: sections 11 and 12, once
 *   EVAL_SEED_ONLY=1 pnpm eval                              # build every starting state; no model, no cost
 *
 * Not in CI: it calls the real model and costs money. A report goes to evals/reports/<date>.md.
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentConfig } from '@/server/agent/config';
import { createAgent } from '@/server/agent/run';
import { conversations, pendingActions, registry, runTool } from '@/server/tools';
import { prisma } from '../tests/helpers/db';
import { owner, storekeeper } from '../tests/helpers/tools';
import { ARTIFACT_ASKED, evaluate, type Case, type TurnRecord } from './assert';
import { freshDatabase, SEEDS } from './seeds';

const KEY = process.env.LIVE_ANTHROPIC_API_KEY;
const RUNS = Number(process.env.EVAL_RUNS ?? 5);
const ONLY = (process.env.EVAL_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SEED_ONLY = process.env.EVAL_SEED_ONLY === '1';

const cases = JSON.parse(readFileSync(join(__dirname, 'cases.json'), 'utf8')) as Case[];

/** A case whose starting state has no seed here cannot run; there are none left since milestone 9. */
const deferredWhy = (c: Case): string | null => (SEEDS[c.state] ? null : `starting state "${c.state}" has no seed`);
const chosen = cases.filter((c) => (ONLY.length ? ONLY.some((p) => c.id === p || c.id.startsWith(p)) : true));
const runnable = chosen.filter((c) => !deferredWhy(c));
const deferred = chosen.filter((c) => !runnable.includes(c));

interface RunResult { pass: boolean; failures: string[]; turns: TurnRecord[]; input: number; output: number; error?: string }
interface CaseResult { id: string; passes: number; runs: number; first?: string; tokensIn: number; tokensOut: number; sample?: TurnRecord[] }

const config = { ...agentConfig({ NODE_ENV: 'test' }), apiKey: KEY ?? 'unset' };
const client = new Anthropic({ apiKey: KEY ?? 'unset', maxRetries: 2 });
// the builder is the same separate call the app makes: it never sees row data
const agent = createAgent({ registry, runTool, pending: pendingActions, store: conversations, client, config, builder: { client, model: config.model, effort: config.effort } });

type Block = { type: string; id?: string; tool_use_id?: string; is_error?: boolean; name?: string; input?: Record<string, unknown>; text?: string };
type ApiRow = { content: { kind: string; blocks?: Block[]; card?: { kind: string; artifactId?: string; title?: string } } };
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

async function playOnce(c: Case): Promise<RunResult> {
  await freshDatabase();
  const sk = await storekeeper(); const ow = await owner();
  const who = c.role === 'OWNER' ? ow : sk;
  const conv = await conversations.create(who.userId);
  const seeded: { sk: typeof sk; ow: typeof ow; conversationId: string; role: Case['role']; openArtifactId?: string } = { sk, ow, conversationId: conv.id, role: c.role };
  await SEEDS[c.state]!(seeded);
  let openArtifactId = seeded.openArtifactId;
  // the seeding is not part of what the agent did; the turns start from here
  const turns: TurnRecord[] = [];
  let input = 0; let output = 0;
  for (const text of c.turns) {
    const startedAt = new Date();
    const before = (await conversations.rows(conv.id)).length;
    await agent.runTurn({ session: who, conversationId: conv.id, text, emit: () => undefined, openArtifactId });
    const rows = (await conversations.rows(conv.id)).slice(before) as unknown as ApiRow[];
    const blocks = rows.filter((r) => r.content.kind === 'api').flatMap((r) => r.content.blocks ?? []);
    const uses = blocks.filter((b) => b.type === 'tool_use');
    const failedUse = new Set(rows.filter((r) => r.content.kind === 'tool_results').flatMap((r) => r.content.blocks ?? []).filter((b) => b.is_error).map((b) => b.tool_use_id));
    const succeeded = (name: string) => uses.filter((u) => u.name === name && !failedUse.has(u.id));
    const cards = rows.flatMap((r) => (r.content.kind === 'card' && r.content.card ? [r.content.card] : []));
    const readCalls = uses.filter((u) => registry.get(u.name ?? '')?.kind === 'read').map((u) => ({ tool: u.name!, input: u.input ?? {} }));
    const forms = await prisma.pendingAction.findMany({ where: { conversationId: conv.id, createdAt: { gte: startedAt } }, orderBy: { createdAt: 'asc' } });
    const audits = await prisma.auditEvent.findMany({ where: { createdAt: { gte: startedAt } } });
    const versions = await prisma.artifactVersion.findMany({ where: { createdAt: { gte: startedAt }, madeBy: 'AGENT' }, include: { artifact: true }, orderBy: { createdAt: 'asc' } });
    const artifacts: TurnRecord['artifacts'] = versions.map((v) => ({ op: v.n === 1 ? 'make' as const : 'edit' as const, artifactId: v.artifactId, kind: v.artifact.kind === 'DOCUMENT' ? 'document' as const : 'page' as const, source: v.source, role: c.role }));
    const opened: TurnRecord['opened'] = succeeded('open_artifact').map((u) => ({ artifactId: str(u.input?.artifactId) ?? '', title: cards.find((k) => k.kind === 'artifact' && k.artifactId === u.input?.artifactId)?.title ?? '' }));
    const prints: TurnRecord['prints'] = succeeded('open_printout').map((u) => ({ template: str(u.input?.template) ?? '', with: (u.input?.with ?? {}) as Record<string, unknown> }));
    const downloads: TurnRecord['downloads'] = [];
    for (const u of succeeded('download_data')) {
      const format = u.input?.format as TurnRecord['downloads'][number]['format'];
      const src = u.input?.source as { tool: string; input?: Record<string, unknown> } | undefined;
      if (src) { downloads.push({ format, source: { tool: src.tool, input: src.input } }); continue; }
      const artifactId = str(u.input?.artifactId) || openArtifactId || '';
      const row = artifactId ? await prisma.artifact.findUnique({ where: { id: artifactId }, select: { kind: true } }) : null;
      downloads.push({ format, source: { artifactId }, ...(row ? { artifactKind: row.kind === 'DOCUMENT' ? 'document' as const : 'page' as const } : {}) });
    }
    const shares: TurnRecord['shares'] = [];
    for (const f of forms.filter((x) => x.toolName === 'share_artifact' || x.toolName === 'unshare_artifact')) {
      const input = (f.proposedInput ?? {}) as { artifactId?: string; version?: number };
      const artifactId = input.artifactId ?? '';
      const art = artifactId ? await prisma.artifact.findUnique({ where: { id: artifactId }, include: { versions: true, currentVersion: true } }) : null;
      const v = art?.versions.find((x) => x.n === input.version) ?? art?.currentVersion;
      shares.push({ tool: f.toolName as 'share_artifact' | 'unshare_artifact', artifactId, ...(v && art ? { source: v.source, kind: art.kind === 'DOCUMENT' ? 'document' as const : 'page' as const } : {}) });
    }
    turns.push({
      user: text,
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim(),
      readCalls,
      pendingActions: forms.map((p) => ({ tool: p.toolName, input: (p.proposedInput ?? {}) as Record<string, unknown> })),
      // making, opening, printing and downloading an artifact leave an audit row, but they change no business data: only a form's button writes
      writesExecuted: audits.filter((a) => a.entityType !== 'Artifact' && !['PRINT', 'DOWNLOAD'].includes(a.action)).map((a) => ({ tool: a.toolName ?? a.action })),
      artifacts, opened, prints, downloads, shares,
      toolCallCount: uses.length,
    });
    // the page opens what was just made or opened, so the next turn starts from it (a form row-button or "add a column" refers to it)
    const lastOpened = [...cards].reverse().find((k) => k.kind === 'artifact' && k.artifactId);
    if (lastOpened?.artifactId) openArtifactId = lastOpened.artifactId;
  }
  const runs = await prisma.agentRun.findMany({ where: { conversationId: conv.id } });
  for (const r of runs) { input += r.inputTokens ?? 0; output += r.outputTokens ?? 0; }
  const failed = runs.find((r) => r.status === 'FAILED');
  const verdict = evaluate(c, { caseId: c.id, role: c.role, turns });
  return { pass: verdict.pass && !failed, failures: failed ? [...verdict.failures, `the assistant was unavailable (${failed.error ?? 'failed'})`] : verdict.failures, turns, input, output, error: failed?.error ?? undefined };
}

const results: CaseResult[] = [];
afterAll(async () => {
  if (SEED_ONLY || !results.length) { await prisma.$disconnect(); return; }
  const date = new Date().toISOString().slice(0, 10);
  const tin = results.reduce((s, r) => s + r.tokensIn, 0); const tout = results.reduce((s, r) => s + r.tokensOut, 0);
  const lines = [
    `# Agent evals · ${date}`, '',
    `${runnable.length} cases run ${RUNS}× each against \`${config.model}\`; ${deferred.length} without a starting state.`,
    'Mechanical checks only (evals/assert.ts: the case checks and the global rules). The `judge` rubrics are not graded by a model here.', '',
    `Tokens: ${tin.toLocaleString('en-IN')} in (cache reads counted at a tenth), ${tout.toLocaleString('en-IN')} out.`, '',
    '| Case | Passes | First failure |', '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.passes}/${r.runs} | ${r.first ? r.first.replace(/\|/g, '/').slice(0, 200) : ''} |`),
    '', `Below ${RUNS}/${RUNS}: ${results.filter((r) => r.passes < r.runs).map((r) => r.id).join(', ') || 'none'}`,
    '', '## Deferred', ...deferred.map((c) => `- ${c.id}: ${deferredWhy(c)}`),
  ];
  mkdirSync(join(__dirname, 'reports'), { recursive: true });
  writeFileSync(join(__dirname, 'reports', `${date}.md`), lines.join('\n') + '\n');
  writeFileSync(join(__dirname, 'reports', `${date}.transcripts.json`), JSON.stringify(results.filter((r) => r.passes < r.runs).map((r) => ({ id: r.id, first: r.first, turns: r.sample })), null, 1));
  console.log(`\n[eval] ${results.filter((r) => r.passes === r.runs).length}/${results.length} cases passed every run · tokens ${tin}+${tout} · report: evals/reports/${date}.md`);
  await prisma.$disconnect();
});

describe.skipIf(!KEY && !SEED_ONLY)(SEED_ONLY ? 'every starting state can be built' : `agent evals (${runnable.length} cases × ${RUNS})`, () => {
  if (SEED_ONLY) {
    for (const state of Object.keys(SEEDS)) {
      it(`state: ${state}`, async () => {
        await freshDatabase();
        const sk = await storekeeper(); const ow = await owner();
        const role = cases.find((c) => c.state === state)?.role ?? 'STOREKEEPER'; // the conversation belongs to whoever the cases run as
        const conv = await conversations.create((role === 'OWNER' ? ow : sk).userId);
        await SEEDS[state]!({ sk, ow, conversationId: conv.id, role });
        expect(await prisma.material.count()).toBeGreaterThan(0);
      }, 120_000);
    }
    return;
  }
  for (const c of runnable) {
    it(`${c.id} · ${c.role.toLowerCase()} · ${c.turns[0]?.slice(0, 60)}`, async () => {
      const r: CaseResult = { id: c.id, passes: 0, runs: RUNS, tokensIn: 0, tokensOut: 0 };
      for (let i = 0; i < RUNS; i++) {
        try {
          const out = await playOnce(c);
          r.tokensIn += out.input; r.tokensOut += out.output;
          if (out.pass) r.passes++;
          else if (!r.first) { r.first = out.failures[0] ?? out.error ?? 'failed'; r.sample = out.turns; }
        } catch (e) {
          if (!r.first) r.first = `runner error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
        }
      }
      results.push(r);
      console.log(`[eval] ${c.id}: ${r.passes}/${r.runs}${r.first ? ` · ${r.first.slice(0, 160)}` : ''}`);
    });
  }
});
