import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for api.anthropic.com that speaks the real streaming protocol (server-sent events), so the real SDK
 * and the real agent code run end to end without a key. A script decides what the "model" says for each request.
 */
export type Block = { type: 'text'; text: string } | { type: 'tool_use'; id?: string; name: string; input: Record<string, unknown> };

export interface StubReply {
  blocks?: Block[];
  stop_reason?: 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens';
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  /** Wait this long before answering (to test the timeout). */
  delayMs?: number;
  /** Answer with an HTTP error instead (to test "the API is down"). */
  httpError?: number;
}

export interface StubRequest {
  n: number;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: IncomingHttpHeaders;
  path: string;
  /** The text of the last user message that is not a tool result. */
  userText: string;
  /** The tool_result blocks in the last user message. */
  toolResults: { tool_use_id: string; content: string; is_error?: boolean }[];
}

export type Script = (req: StubRequest) => StubReply | Promise<StubReply>;

export interface Stub { url: string; requests: StubRequest[]; close: () => Promise<void> }

export const say = (text: string): StubReply => ({ blocks: [{ type: 'text', text }] });
export const call = (name: string, input: Record<string, unknown> = {}, lead?: string): StubReply => ({
  blocks: [...(lead ? [{ type: 'text' as const, text: lead }] : []), { type: 'tool_use', name, input }],
});

let toolSeq = 0;

export async function startStub(script: Script, port = 0): Promise<Stub> {
  const requests: StubRequest[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('stub ok'); return; } // for a readiness check
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const msgs = (body.messages ?? []) as { role: string; content: unknown }[];
      const last = [...msgs].reverse().find((m) => m.role === 'user');
      type Block = { type: string; text?: string; tool_use_id?: string; content?: string; is_error?: boolean };
      const blocksOf = (m?: { content: unknown }) => (Array.isArray(m?.content) ? (m?.content as Block[]) : []);
      const textOf = (m: { content: unknown }) => (typeof m.content === 'string' ? m.content : blocksOf(m).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
      const blocks = blocksOf(last);
      const lastWithText = [...msgs].reverse().find((m) => m.role === 'user' && textOf(m).trim() !== '');
      const r: StubRequest = {
        n: requests.length, body, headers: req.headers, path: req.url ?? '',
        userText: lastWithText ? textOf(lastWithText) : '',
        toolResults: blocks.filter((b) => b.type === 'tool_result').map((b) => ({ tool_use_id: b.tool_use_id as string, content: String(b.content), is_error: b.is_error })),
      };
      requests.push(r);

      const reply = await script(r);
      if (reply.delayMs) await new Promise((ok) => setTimeout(ok, reply.delayMs));
      if (reply.httpError) {
        res.writeHead(reply.httpError, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'internal details that must never reach a user' } }));
        return;
      }

      const content = (reply.blocks ?? []).map((b) => (b.type === 'tool_use' ? { ...b, id: b.id ?? `toolu_${String(++toolSeq).padStart(4, '0')}` } : b));
      const stop = reply.stop_reason ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
      const usage = reply.usage ?? { input_tokens: 120, output_tokens: 30 };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1, cache_read_input_tokens: usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0 } } });
      content.forEach((b, index) => {
        if (b.type === 'text') {
          send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
          const mid = Math.ceil(b.text.length / 2);
          for (const part of [b.text.slice(0, mid), b.text.slice(mid)]) if (part) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: part } });
        } else {
          send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
          const json = JSON.stringify(b.input);
          const mid = Math.ceil(json.length / 2);
          for (const part of [json.slice(0, mid), json.slice(mid)]) send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } });
        }
        send('content_block_stop', { type: 'content_block_stop', index });
      });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok));
  const { port: bound } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${bound}`, requests, close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }) };
}
