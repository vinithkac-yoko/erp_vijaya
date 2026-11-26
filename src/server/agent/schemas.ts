import type Anthropic from '@anthropic-ai/sdk';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Role } from '@/lib/catalog';
import type { Registry } from '../tools/registry';
import type { RegisteredTool } from '../tools/types';

/** JSON Schema for one tool's input, with the model-facing descriptions merged in and the hidden keys taken out. */
export function inputSchema(tool: RegisteredTool): Anthropic.Tool.InputSchema {
  const raw = zodToJsonSchema(tool.input, { target: 'jsonSchema7', $refStrategy: 'none', effectStrategy: 'input' }) as Record<string, unknown>;
  delete raw.$schema;
  const props = { ...((raw.properties as Record<string, Record<string, unknown>> | undefined) ?? {}) };
  for (const hidden of tool.agentHidden ?? []) delete props[hidden];
  for (const [k, p] of Object.entries(props)) {
    const text = tool.inputDescriptions[k];
    if (text) props[k] = { ...p, description: text };
  }
  const required = ((raw.required as string[] | undefined) ?? []).filter((k) => k in props);
  return { type: 'object', properties: props, ...(required.length ? { required } : {}) } as Anthropic.Tool.InputSchema;
}

/**
 * The tools the model is offered for this role. Only the role's own tools, in a fixed order (so the request prefix is the
 * same every time and can be cached). A storekeeper's assistant never sees approve_*, update_setting, create_user…
 * (docs/AGENT_PROMPT.md still tells it to explain who does those.)
 */
export function agentTools(registry: Registry, role: Role): Anthropic.Tool[] {
  return registry.forRole(role)
    .filter((t) => t.agentVisible)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, description: t.description, input_schema: inputSchema(t) }));
}

/** The keys the model may not fill in for this tool (a password). Dropped from whatever it sends. */
export function stripHidden(tool: RegisteredTool, input: unknown): Record<string, unknown> {
  const o = input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  for (const h of tool.agentHidden ?? []) delete o[h];
  return o;
}
