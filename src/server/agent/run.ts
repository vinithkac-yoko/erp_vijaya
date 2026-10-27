import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { Card, ChatItem, Chip } from '@/lib/cards';
import type { Role } from '@/lib/catalog';
import { systemPrompt, sessionContext } from './prompt';
import { ASSISTANT_DOWN, ASSISTANT_OFF, type AgentConfig } from './config';
import type { ChatEvent } from './events';
import { toApiMessages, wrapData } from './history';
import { redactSecrets } from './redact';
import { agentTools, stripHidden } from './schemas';
import { APP_TOOLS, appToolDefs, runAppTool } from '../artifacts/app-tools';
import type { BuilderModel } from '../artifacts/builder';
import type { conversationStore } from '../tools/conversations';
import type { createPendingService } from '../tools/pending';
import type { Registry } from '../tools/registry';
import type { createRunTool } from '../tools/run-tool';
import type { ToolSession } from '../tools/types';

type Store = ReturnType<typeof conversationStore>;
type Msg = Anthropic.Beta.Messages.BetaMessageParam;

export interface AgentDeps {
  registry: Registry;
  runTool: ReturnType<typeof createRunTool>;
  pending: ReturnType<typeof createPendingService>;
  store: Store;
  client: Anthropic;
  config: AgentConfig;
  now?: () => Date;
  /** The model the artifact builder uses (a separate call that never sees row data). Null: no artifacts. */
  builder?: BuilderModel | null;
  /** Contextual chips for the end of a turn (see chat/chips.ts). */
  chips?: (role: Role, usedTools: string[], lastAsk: string) => Chip[];
}

export interface TurnInput {
  session: ToolSession;
  conversationId: string;
  text: string;
  /** Which launcher chip sent this, if one did (counted for "top used first"). */
  chip?: string;
  /** The artifact open beside the chat, if any: the default for "change it" and "download it". */
  openArtifactId?: string;
  emit: (e: ChatEvent) => void;
  signal?: AbortSignal;
}

/** What the person sees while a tool runs. Never a bare spinner (INTERFACE §11). */
const STATUS: Record<string, string> = {
  search_materials: 'Looking up materials…', get_material_balance: 'Checking stock…', search_parties: 'Looking up suppliers and customers…',
  list_reorder_alerts: 'Checking what is low…', make_artifact: 'Building it. This can take a little while…', edit_artifact: 'Making the change…', open_printout: 'Getting the printout ready…', list_artifacts: 'Looking at what you have made…', list_pending_approvals: 'Checking what is waiting…', list_settings: 'Looking at the settings…', list_users: 'Looking up the logins…',
};

const SAY_IT = 'Now write the one short sentence the user needs before they check the form: what is filled in and what to check, following the rules for what it says. Plain words. Do not say it is done or saved.';
const FORM_OPENED = 'A form is now open for the user with those details filled in. Nothing is saved until the user checks it and presses its button. Do not say it is done.';
/**
 * One turn of the assistant. It can look things up (reads run and show as tables) and it can open a form (a write tool
 * never runs: it creates a PendingAction for the person to submit). It cannot change anything itself, and it cannot say
 * something was saved: the server draws that card when the person presses the button.
 */
export function createAgent(deps: AgentDeps) {
  const { registry, runTool, pending, store, client, config } = deps;
  const now = deps.now ?? (() => new Date());

  async function show(conversationId: string, card: Card, emit: (e: ChatEvent) => void, runId?: string): Promise<ChatItem> {
    const row = await store.append(conversationId, 'CARD', { kind: 'card', card }, runId);
    const item: ChatItem = { id: row.id, role: 'card', card, ...(card.kind === 'form' ? { state: 'open' as const } : {}) };
    emit({ type: 'item', item });
    return item;
  }

  async function runTurn(input: TurnInput): Promise<void> {
    const { session, conversationId, emit } = input;
    const t0 = Date.now();

    // A password typed into the chat is hidden before anything is saved or sent to the model.
    const safe = redactSecrets(input.text);
    await store.append(conversationId, 'USER', { kind: 'text', text: safe.text, chip: input.chip });
    await store.setTitleIfEmpty(conversationId, safe.text);
    if (safe.hidden) {
      await show(conversationId, { kind: 'notice', tone: 'warn', text: 'I hid the password you typed. Please type passwords only in the form, never in the chat.' }, emit);
    }

    if (!config.enabled || !config.apiKey) {
      await show(conversationId, { kind: 'notice', tone: 'info', text: ASSISTANT_OFF }, emit);
      emit({ type: 'done' });
      return;
    }
    if ((await store.tokensToday(session.userId, now())) >= config.dailyTokens) {
      await show(conversationId, { kind: 'notice', tone: 'info', text: "You have used today's share of the assistant. The buttons above still work, and it starts again tomorrow." }, emit);
      emit({ type: 'done' });
      return;
    }

    const run = await store.startRun(session.userId, conversationId, config.model);
    const usage = { inputTokens: 0, outputTokens: 0 };
    const calls: { tool: string; ok: boolean; rows?: number }[] = [];
    const tools = [...agentTools(registry, session.role), ...appToolDefs(session.role)].sort((a, b) => a.name.localeCompare(b.name));

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('turn timed out')), config.turnTimeoutMs);
    const onAbort = () => timeout.abort(new Error('cancelled'));
    input.signal?.addEventListener('abort', onAbort);

    let status: 'DONE' | 'FAILED' | 'LIMITED' = 'DONE';
    let failure: string | undefined;
    try {
      const waiting = session.role === 'OWNER' ? await ownerWaiting(session) : undefined;
      const counting = await countingNow(session);
      const system = [
        { type: 'text' as const, text: systemPrompt(), cache_control: { type: 'ephemeral' as const } },
        { type: 'text' as const, text: sessionContext({ name: session.name, role: session.role, now: now(), waiting, counting }) },
      ];

      let toolCalls = 0;
      for (let step = 0; ; step++) {
        const messages: Msg[] = toApiMessages(await store.rows(conversationId));
        const textId = randomUUID();
        const stream = client.beta.messages.stream({
          model: config.model,
          max_tokens: 16000,
          system,
          tools,
          messages,
          output_config: { effort: config.effort },
          ...(config.refusalFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        }, { signal: timeout.signal });
        stream.on('text', (delta) => emit({ type: 'text', id: textId, delta }));
        stream.on('streamEvent', (ev) => {
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') emit({ type: 'status', text: STATUS[ev.content_block.name] ?? 'Working on it…' });
        });
        const reply = await stream.finalMessage();
        usage.inputTokens += (reply.usage.input_tokens ?? 0) + (reply.usage.cache_creation_input_tokens ?? 0) + Math.ceil((reply.usage.cache_read_input_tokens ?? 0) / 10);
        usage.outputTokens += reply.usage.output_tokens ?? 0;

        await store.append(conversationId, 'ASSISTANT', { kind: 'api', blocks: reply.content }, run.id);

        if (reply.stop_reason === 'refusal') {
          await show(conversationId, { kind: 'notice', tone: 'info', text: "I can't help with that one. Try asking in a different way." }, emit, run.id);
          break;
        }
        if (reply.stop_reason === 'max_tokens') {
          await show(conversationId, { kind: 'notice', tone: 'info', text: 'That answer got cut off. Please ask again, a little shorter.' }, emit, run.id);
          break;
        }
        if (reply.stop_reason !== 'tool_use') {
          if (reply.stop_reason === 'end_turn') {
            const chips = deps.chips?.(session.role, calls.map((c) => c.tool), safe.text) ?? [];
            if (chips.length) emit({ type: 'chips', chips });
          }
          break;
        }

        const uses = reply.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use');
        const results: { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }[] = [];
        let formOpened = false;
        let formCard: Card | undefined;
        let limited = false;

        for (const use of uses) {
          if (toolCalls >= config.maxToolCalls) {
            limited = true;
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Too many steps in one turn. Stop and tell the user what you found so far.' });
            continue;
          }
          toolCalls++;
          if (APP_TOOLS[use.name]) {
            emit({ type: 'status', text: STATUS[use.name] ?? 'Working on it…' });
            const texts = (await store.rows(conversationId)).flatMap((r) => { const c = r.content as { kind?: string; text?: string }; return c.kind === 'text' && c.text ? [c.text] : []; }).slice(-3);
            const out = await runAppTool(use.name, { session, conversationId, runId: run.id, userTexts: texts, openArtifactId: input.openArtifactId, builder: deps.builder ?? null, runTool, now: now() }, use.input);
            if (out.usage) { usage.inputTokens += out.usage.input; usage.outputTokens += out.usage.output; }
            for (const c of out.cards ?? []) await show(conversationId, c, emit, run.id);
            calls.push({ tool: use.name, ok: !out.isError });
            results.push({ type: 'tool_result', tool_use_id: use.id, content: out.text, ...(out.isError ? { is_error: true } : {}) });
            continue;
          }
          const tool = registry.get(use.name);
          if (!tool || !tool.agentVisible || !tool.roles.includes(session.role)) {
            // the model asked for something it was not offered (or made a name up): refused like any unknown tool
            calls.push({ tool: use.name, ok: false });
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: JSON.stringify({ error: "I can't do that." }) });
            continue;
          }

          if (tool.kind === 'read') {
            emit({ type: 'status', text: STATUS[use.name] ?? 'Working on it…' });
            const out = await runTool(session, use.name, use.input);
            if (out.ok) {
              const cards = tool.view ? (tool.view as (d: unknown) => Card[])(out.data) : [];
              for (const c of cards) await show(conversationId, c, emit, run.id);
              calls.push({ tool: use.name, ok: true, rows: Array.isArray((out.data as { rows?: unknown[] })?.rows) ? (out.data as { rows: unknown[] }).rows.length : undefined });
              results.push({ type: 'tool_result', tool_use_id: use.id, content: wrapData(use.name, out.data) });
            } else {
              calls.push({ tool: use.name, ok: false });
              results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: JSON.stringify({ error: out.message }) });
            }
            continue;
          }

          // A write: it opens a form. It never runs.
          if (formOpened) {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Only one form can be open at a time. Tell the user to finish this one first.' });
            continue;
          }
          const opened = await pending.create(session, { tool: use.name, input: stripHidden(tool, use.input), origin: 'AGENT', conversationId, agentRunId: run.id });
          calls.push({ tool: use.name, ok: opened.ok });
          if (!opened.ok) {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: JSON.stringify({ error: opened.message }) });
            continue;
          }
          if (tool.kind !== 'write') continue;
          formOpened = true;
          formCard = await pending.formCard(session, opened.data);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: FORM_OPENED });
        }

        // A form ends the turn, so what the person should check has to be said now. If the message that opened it had no
        // words, ask for the one sentence (no tools) and show it above the form.
        const spoke = reply.content.some((b) => b.type === 'text' && b.text.trim().length > 0);
        const silent = formOpened && !spoke;
        await store.append(conversationId, 'USER', { kind: 'tool_results', blocks: silent ? [...results, { type: 'text', text: SAY_IT }] : results }, run.id);
        if (silent) {
          const say = client.beta.messages.stream({
            model: config.model, max_tokens: 600, system, tools, tool_choice: { type: 'none' }, messages: toApiMessages(await store.rows(conversationId)),
            output_config: { effort: config.effort },
          }, { signal: timeout.signal });
          const sayId = randomUUID();
          say.on('text', (delta) => emit({ type: 'text', id: sayId, delta }));
          const said = await say.finalMessage();
          usage.inputTokens += (said.usage.input_tokens ?? 0) + (said.usage.cache_creation_input_tokens ?? 0) + Math.ceil((said.usage.cache_read_input_tokens ?? 0) / 10);
          usage.outputTokens += said.usage.output_tokens ?? 0;
          await store.append(conversationId, 'ASSISTANT', { kind: 'api', blocks: said.content }, run.id);
        }
        if (formCard) await show(conversationId, formCard, emit, run.id);

        if (formOpened) break; // the turn ends with the form on the screen
        if (limited) {
          status = 'LIMITED';
          await show(conversationId, { kind: 'notice', tone: 'info', text: `I stopped after ${config.maxToolCalls} steps. Please ask again, a little more simply.` }, emit, run.id);
          break;
        }
      }
    } catch (err) {
      if (timeout.signal.aborted && String(timeout.signal.reason).includes('timed out')) {
        status = 'LIMITED';
        await show(conversationId, { kind: 'notice', tone: 'info', text: 'That took too long, so I stopped. Please try again.' }, emit, run.id);
      } else if (input.signal?.aborted) {
        status = 'LIMITED';
      } else {
        status = 'FAILED';
        failure = err instanceof Anthropic.APIError ? `API ${err.status ?? ''} ${err.name}` : err instanceof Error ? err.name : 'unknown';
        console.error('[agent] turn failed:', failure);
        await show(conversationId, { kind: 'notice', tone: 'info', text: ASSISTANT_DOWN }, emit, run.id);
      }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      await store.finishRun(run.id, status, usage, calls, t0, failure);
      emit({ type: 'done' });
    }
  }

  /** A count open for counting (or sent back for a recount), so "tape 820" is understood as a count entry. */
  async function countingNow(session: ToolSession) {
    const r = await runTool(session, 'list_counts', {});
    if (!r.ok) return undefined;
    const open = (r.data as { rows: { number: string; type: string; status: string; counted: number; total: number }[] }).rows.find((c) => c.status === 'DRAFT' || c.status === 'REJECTED');
    return open ? { number: open.number, opening: /opening/i.test(open.type), counted: open.counted, total: open.total } : undefined;
  }

  /** The owner's context line: how many things wait for him (the same read tool the opening card uses). */
  async function ownerWaiting(session: ToolSession) {
    const r = await runTool(session, 'list_pending_approvals', {});
    if (!r.ok) return undefined;
    const d = r.data as { purchaseOrders: unknown[]; counts: unknown[] };
    return { purchaseOrders: d.purchaseOrders.length, counts: d.counts.length };
  }

  /**
   * After a form is saved: one or two plain sentences about what the follow-up checks found (a shortage, a rate change).
   * No tools are offered, so it can only talk. Returns the sentence, saved in the chat like any reply.
   */
  async function followUp(session: ToolSession, conversationId: string, facts: string[]): Promise<string | null> {
    if (!config.enabled || !config.apiKey || facts.length === 0) return null;
    if ((await store.tokensToday(session.userId, now())) >= config.dailyTokens) return null;
    const run = await store.startRun(session.userId, conversationId, config.model);
    const t0 = Date.now();
    try {
      await store.append(conversationId, 'USER', { kind: 'notice', text: `Checks that ran after the save found: ${facts.join(' ')} Tell the user in one or two plain sentences. Do not open a form.` }, run.id);
      const messages: Msg[] = toApiMessages(await store.rows(conversationId));
      const reply = await client.beta.messages.stream({
        model: config.model, max_tokens: 1000, messages, output_config: { effort: config.effort },
        system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }, { type: 'text', text: sessionContext({ name: session.name, role: session.role, now: now() }) }],
      }, { signal: AbortSignal.timeout(config.turnTimeoutMs) }).finalMessage();
      await store.append(conversationId, 'ASSISTANT', { kind: 'api', blocks: reply.content }, run.id);
      await store.finishRun(run.id, 'DONE', { inputTokens: reply.usage.input_tokens ?? 0, outputTokens: reply.usage.output_tokens ?? 0 }, [], t0);
      return reply.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n\n').trim() || null;
    } catch {
      await store.finishRun(run.id, 'FAILED', { inputTokens: 0, outputTokens: 0 }, [], t0, 'follow-up failed');
      return null; // a failed follow-up shows nothing extra (TOOL_CATALOG)
    }
  }

  return { runTurn, followUp };
}

export type Agent = ReturnType<typeof createAgent>;
