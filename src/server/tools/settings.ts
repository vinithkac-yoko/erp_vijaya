import { z } from 'zod';
import { displaySetting, parseSetting, SETTINGS, settingDef } from '@/lib/settings';
import { ToolError } from '../errors';
import { defineTool } from './define';
import type { Db } from './types';

/**
 * Reads a setting from the database. A missing value is an ERROR, never a quiet default: if the approval limit can't
 * be read, a purchase order must not be created at some made-up limit (TOOL_CATALOG §4).
 */
export async function readSetting(db: Db, key: string): Promise<string> {
  const def = settingDef(key);
  if (!def) throw new Error(`unknown setting ${key}`);
  const row = await db.setting.findUnique({ where: { key } });
  if (!row) throw new ToolError('SETTING_MISSING', `The setting "${def.label}" is not set. Ask the owner to set it.`);
  return row.value;
}

/** The assistant's own switch. Missing means on (a kill switch must default to working, and the env var is the hard stop). */
export async function assistantSettingOn(db: Db): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: 'agent.enabled' } });
  return row?.value !== 'off';
}

const isOwner = (role: string) => role === 'OWNER';

export const listSettings = defineTool({
  name: 'list_settings', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({}),
  handler: async (ctx) => {
    const defs = SETTINGS.filter((s) => isOwner(ctx.session.role) || s.storekeeperCanRead);
    const stored = await ctx.db.setting.findMany({ where: { key: { in: defs.map((d) => d.key) } } });
    return { rows: defs.map((d) => ({ key: d.key, setting: d.label, value: displaySetting(d, stored.find((s) => s.key === d.key)?.value ?? d.initial), help: d.help })) };
  },
  view: (d) => [{ kind: 'table', columns: [{ key: 'setting', label: 'Setting' }, { key: 'value', label: 'Now', align: 'right' }], rows: d.rows.map((r) => ({ setting: r.setting, value: r.value })) }],
});

export const updateSetting = defineTool({
  name: 'update_setting', kind: 'write', roles: ['OWNER'],
  input: z.object({
    key: z.string({ required_error: 'Choose the setting.' }).min(1, 'Choose the setting.').max(80),
    value: z.union([z.string(), z.number(), z.boolean()], { errorMap: () => ({ message: 'Type the new value.' }) }),
  }),
  form: {
    title: 'Change a setting', verb: 'Save setting',
    fields: [
      { name: 'key', label: 'Setting', type: 'select', required: true, options: SETTINGS.map((s) => ({ value: s.key, label: s.label })) },
      { name: 'value', label: 'New value', type: 'text', required: true, hint: SETTINGS.map((s) => `${s.label}: ${s.help}`).join('  ·  ') },
    ],
  },
  stamp: 'SETTING SAVED',
  describe: (a) => [`${a.setting}: ${a.now}`, ...(a.was !== undefined ? [`Was: ${a.was}`] : [])],
  handler: async (ctx, input) => {
    const def = settingDef(input.key);
    if (!def) throw new ToolError('UNKNOWN_SETTING', "That isn't a setting you can change.", undefined, 'key');
    const parsed = parseSetting(def, input.value);
    if (!parsed.ok) throw new ToolError('INVALID_INPUT', parsed.message, undefined, 'value');
    const before = await ctx.db.setting.findUnique({ where: { key: def.key } });
    await ctx.db.setting.upsert({
      where: { key: def.key },
      create: { key: def.key, value: parsed.stored, valueType: def.type, description: def.help, updatedById: ctx.session.userId },
      update: { value: parsed.stored, updatedById: ctx.session.userId },
    });
    const was = before ? displaySetting(def, before.value) : undefined;
    const now = displaySetting(def, parsed.stored);
    return { data: { setting: def.label, now }, audit: { entityType: 'Setting', entityId: def.key, action: 'UPDATE', before: { setting: def.label, value: was }, after: { setting: def.label, now, was } } };
  },
});

