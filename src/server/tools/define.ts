import type { z } from 'zod';
import { TOOLS } from '@/lib/catalog';
import descriptions from '../../../prompts/tool-descriptions.json';
import type { AnyTool, ReadTool, RegisteredTool, WriteTool } from './types';

interface Described { description: string; inputs: Record<string, string>; agent?: boolean }
const TEXT = (descriptions as { tools: Record<string, Described> }).tools;

/** The exact words the model sees for a tool. Generated from prompts/build_tool_descriptions.py — never edited here. */
export function toolText(name: string): Described {
  const t = TEXT[name];
  if (!t) throw new Error(`prompts/tool-descriptions.json has no entry for "${name}". Edit prompts/build_tool_descriptions.py and regenerate.`);
  return t;
}

/**
 * Defines a tool. It refuses (at start-up, loudly) a tool that is not in the catalog, that disagrees with the catalog
 * about its kind or roles, or that has no roles. Text comes from the generated file, never from the caller.
 */
export function defineTool<I extends z.ZodTypeAny, O>(def: ReadTool<I, O>): RegisteredTool;
export function defineTool<I extends z.ZodTypeAny, O>(def: WriteTool<I, O>): RegisteredTool;
export function defineTool(def: AnyTool): RegisteredTool {
  const meta = TOOLS[def.name];
  if (!meta) throw new Error(`Tool "${def.name}" is not in the catalog (src/lib/catalog.ts, docs/TOOL_CATALOG.md).`);
  if (!Array.isArray(def.roles) || def.roles.length === 0) throw new Error(`Tool "${def.name}" must declare its roles.`);
  if (meta.kind !== def.kind) throw new Error(`Tool "${def.name}" is a ${def.kind} here but a ${meta.kind} in the catalog.`);
  if ([...meta.roles].sort().join() !== [...def.roles].sort().join()) {
    throw new Error(`Tool "${def.name}" has roles ${def.roles.join('+')} here but ${meta.roles.join('+')} in the catalog.`);
  }
  const text = toolText(def.name);
  return { ...def, description: text.description, inputDescriptions: text.inputs, agentVisible: text.agent !== false } as RegisteredTool;
}
