import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { materialNameKey } from '@/lib/names';
import { isSimilar, materialProfile, search } from '@/lib/similar';
import { qty, UOM_CHOICES, UOM_LONG, UOM_SHORT } from '@/lib/format';
import { ToolError } from '../errors';
import { defineTool } from './define';
import { flag, id, opt, optNum, pick, req, tidy } from './helpers';
import { nextCode } from './numbers';
import type { Db } from './types';

const UOMS = ['KG', 'NOS', 'MTR', 'LTR', 'ROLL', 'SET'] as const;
const STOCK_TYPES = ['STANDING', 'PER_JOB'] as const;
const KEPT_AS: Record<string, string> = { STANDING: 'Kept in stock', PER_JOB: 'Bought per job' };

type Row = Prisma.MaterialGetPayload<{ include: { balance: true } }>;
const num = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d));

const toRow = (m: Row) => ({
  id: m.id, name: m.name, unit: m.uom, stockType: m.stockType, isScrap: m.isScrap, isActive: m.isActive,
  onHand: num(m.balance?.quantity) ?? 0, minimumLevel: num(m.minimumLevel),
});

const allMaterials = (db: Db, includeInactive = false) =>
  db.material.findMany({ where: includeInactive ? {} : { isActive: true }, include: { balance: true }, orderBy: { name: 'asc' } });

const MAX_ROWS_IN_CHAT = 10;

// ── search_materials ───────────────────────────────────────────────────────────────────────────────
export const searchMaterials = defineTool({
  name: 'search_materials', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ query: opt(100), stockType: z.preprocess((v) => (v === '' ? undefined : v), z.enum(STOCK_TYPES).optional()), includeInactive: flag.optional() }),
  handler: async (ctx, input) => {
    let rows = (await allMaterials(ctx.db, input.includeInactive)).filter((m) => !input.stockType || m.stockType === input.stockType);
    if (input.query) rows = search(input.query, rows, (m) => m.nameKey, (m) => m.name);
    return { total: rows.length, rows: rows.slice(0, 100).map(toRow) };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'name', label: 'Material' }, { key: 'kept', label: 'Kept as' }, { key: 'onHand', label: 'On hand', align: 'right' }, { key: 'min', label: 'Minimum', align: 'right' }],
    rows: d.rows.slice(0, MAX_ROWS_IN_CHAT).map((r) => ({
      name: r.name + (r.isActive ? '' : ' (no longer in use)'), kept: KEPT_AS[r.stockType] ?? r.stockType,
      onHand: qty(r.onHand, r.unit), min: r.minimumLevel === null ? '–' : qty(r.minimumLevel, r.unit),
    })),
    note: d.total > MAX_ROWS_IN_CHAT ? `Showing ${MAX_ROWS_IN_CHAT} of ${d.total}.` : undefined,
  }],
});

// ── get_material_balance ───────────────────────────────────────────────────────────────────────────
export const getMaterialBalance = defineTool({
  name: 'get_material_balance', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ materialIds: z.array(id('material')).max(50).optional(), materialNames: z.array(z.string().max(100)).max(50).optional() }),
  handler: async (ctx, input) => {
    const all = await allMaterials(ctx.db);
    let chosen: Row[];
    const notFound: string[] = [];
    if (input.materialIds?.length || input.materialNames?.length) {
      const seen = new Map<string, Row>();
      for (const mid of input.materialIds ?? []) { const m = all.find((x) => x.id === mid); if (m) seen.set(m.id, m); }
      for (const name of input.materialNames ?? []) {
        const exact = all.find((m) => m.nameKey === materialNameKey(name));
        const hits = exact ? [exact] : search(name, all, (m) => m.nameKey, (m) => m.name).slice(0, 5);
        if (hits.length === 0) notFound.push(name);
        for (const m of hits) seen.set(m.id, m);
      }
      chosen = [...seen.values()];
    } else {
      chosen = all;
    }
    const rows = chosen.slice(0, 200).map((m) => {
      const onHand = num(m.balance?.quantity) ?? 0;
      const min = num(m.minimumLevel);
      return {
        materialId: m.id, material: m.name, unit: m.uom, quantity: onHand, averageRate: num(m.balance?.averageRate) ?? 0,
        value: num(m.balance?.stockValue) ?? 0, minimumLevel: min, stockType: m.stockType,
        isNegative: onHand < 0, belowMinimum: m.stockType === 'STANDING' && min !== null && onHand < min,
      };
    });
    return { rows, notFound, truncated: chosen.length > 200 };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'm', label: 'Material' }, { key: 'q', label: 'On hand', align: 'right' }, { key: 'r', label: 'Rate', align: 'right' }, { key: 'v', label: 'Value', align: 'right' }],
    rows: d.rows.slice(0, MAX_ROWS_IN_CHAT).map((r) => ({
      m: r.material, q: qty(r.quantity, r.unit) + (r.isNegative ? ' (negative)' : r.belowMinimum ? ' (below minimum)' : ''),
      r: `₹${r.averageRate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}/${UOM_SHORT[r.unit] ?? ''}`,
      v: '₹' + Math.round(r.value).toLocaleString('en-IN'),
    })),
    note: d.rows.length > MAX_ROWS_IN_CHAT ? `Showing ${MAX_ROWS_IN_CHAT} of ${d.rows.length}.` : d.notFound.length ? `Couldn't find: ${d.notFound.join(', ')}. Check the spelling.` : undefined,
  }],
});

// ── create_material ────────────────────────────────────────────────────────────────────────────────
export const createMaterial = defineTool({
  name: 'create_material', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    name: req('material name', 120),
    uom: pick(UOMS, 'Choose the unit from the list.'),
    stockType: pick(STOCK_TYPES, 'Choose how it is bought.'),
    minimumLevel: optNum('minimum level'),
    hsnCode: opt(20),
    gstRate: optNum('GST rate', 0, 100),
    isScrap: flag.optional(),
    confirmNotDuplicate: flag.optional(),
  }),
  form: {
    title: 'Add a material', verb: 'Add material',
    fields: [
      { name: 'name', label: 'Material name', type: 'text', required: true, hint: 'As the notebook writes it, like 22 SWG Copper Wire. No supplier or city.' },
      { name: 'uom', label: 'Unit', type: 'select', required: true, options: UOM_CHOICES, hint: "One unit for buying and giving out. It can't be changed later." },
      { name: 'stockType', label: 'How is it bought?', type: 'select', required: true,
        options: [{ value: 'STANDING', label: 'Kept in stock (has a minimum level)' }, { value: 'PER_JOB', label: 'Bought for each job' }] },
      { name: 'minimumLevel', label: 'Minimum level', type: 'number', required: true, showWhen: { field: 'stockType', in: ['STANDING'] }, hint: 'You are told when stock goes below this.' },
      { name: 'hsnCode', label: 'HSN code', type: 'text', hint: 'If you have it.' },
      { name: 'gstRate', label: 'GST rate', type: 'number', unit: '%', hint: 'If you have it, like 18.' },
      { name: 'isScrap', label: 'This is scrap we collect and sell', type: 'checkbox' },
    ],
  },
  stamp: 'MATERIAL ADDED',
  describe: (a) => [String(a.name), `Unit: ${UOM_LONG[String(a.uom)] ?? a.uom}`, a.stockType === 'STANDING' ? `Kept in stock, minimum ${qty(Number(a.minimumLevel), String(a.uom))}` : 'Bought for each job'],
  handler: async (ctx, input) => {
    const name = tidy(input.name);
    const key = materialNameKey(name);
    if (!key) throw new ToolError('INVALID_INPUT', 'Type the material name.', undefined, 'name');

    if (input.stockType === 'STANDING' && input.minimumLevel === undefined) {
      throw new ToolError('MINIMUM_REQUIRED', 'Material kept in stock needs a minimum level.', undefined, 'minimumLevel');
    }
    const existing = await ctx.db.material.findMany({ select: { name: true, nameKey: true, uom: true, isActive: true } });
    const same = existing.find((m) => m.nameKey === key);
    if (same) throw new ToolError('MATERIAL_EXISTS', `"${same.name}" is already in the list${same.isActive ? '' : ' (no longer in use)'}.`, undefined, 'name');

    if (!input.confirmNotDuplicate) {
      const me = materialProfile(name);
      const matches = existing.filter((m) => isSimilar(me, materialProfile(m.name))).slice(0, 3);
      if (matches.length) {
        throw new ToolError('SIMILAR_MATERIAL_EXISTS',
          `This looks like ${matches.map((m) => `"${m.name}"`).join(' or ')}. Is it the same material?`,
          { matches: matches.map((m) => ({ name: m.name, unit: UOM_LONG[m.uom] ?? m.uom })) }, 'name');
      }
    }

    const m = await ctx.db.material.create({
      data: {
        code: await nextCode(ctx.db, 'MAT'), name, nameKey: key, uom: input.uom, stockType: input.stockType,
        minimumLevel: input.stockType === 'STANDING' ? input.minimumLevel : null,
        hsnCode: input.hsnCode, gstRate: input.gstRate, isScrap: input.isScrap ?? false,
      },
    });
    // A material added while the opening count is still with the storekeeper joins that count (nothing counted yet), so it is not missed.
    const opening = await ctx.db.stockCount.findFirst({ where: { isOpening: true, status: { in: ['DRAFT', 'REJECTED'] } }, select: { id: true } });
    if (opening) await ctx.db.stockCountLine.create({ data: { stockCountId: opening.id, materialId: m.id, systemQty: 0 } });
    return {
      data: { id: m.id, name: m.name, unit: m.uom },
      audit: { entityType: 'Material', entityId: m.id, action: 'CREATE', after: { name: m.name, uom: m.uom, stockType: m.stockType, minimumLevel: num(m.minimumLevel), hsnCode: m.hsnCode, gstRate: num(m.gstRate), isScrap: m.isScrap } },
    };
  },
});

// ── update_material ────────────────────────────────────────────────────────────────────────────────
const refuseUnitChange = (v: unknown) => {
  if (v && typeof v === 'object' && ('uom' in v || 'stockType' in v)) {
    throw new ToolError('UNIT_LOCKED', "The unit and the way a material is bought can't be changed, because every past quantity would then mean something different.");
  }
  return v;
};

export const updateMaterial = defineTool({
  name: 'update_material', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.preprocess(refuseUnitChange, z.object({
    materialId: id('material'), name: opt(120), minimumLevel: optNum('minimum level'), hsnCode: opt(20), gstRate: optNum('GST rate', 0, 100),
  })),
  form: {
    title: 'Change a material', verb: 'Save changes', intro: "Leave a box empty to keep what is there. The unit and the way it is bought can't be changed.",
    fields: [
      { name: 'materialId', label: 'Material', type: 'material', required: true },
      { name: 'name', label: 'New name', type: 'text', hint: 'Only if you are renaming it.' },
      { name: 'minimumLevel', label: 'Minimum level', type: 'number', hint: 'Only for material kept in stock.' },
      { name: 'hsnCode', label: 'HSN code', type: 'text' },
      { name: 'gstRate', label: 'GST rate', type: 'number', unit: '%' },
    ],
  },
  stamp: 'MATERIAL CHANGED',
  describe: (a) => [String(a.name), ...Object.entries((a.changes ?? {}) as Record<string, unknown>).map(([k, v]) => `${k === 'name' ? 'Name' : k === 'minimumLevel' ? 'Minimum level' : k === 'hsnCode' ? 'HSN code' : 'GST rate'}: ${v}`)],
  handler: async (ctx, input) => {
    const m = await ctx.db.material.findUnique({ where: { id: input.materialId } });
    if (!m) throw new ToolError('NOT_FOUND', "Couldn't find that material. Check the spelling.", undefined, 'materialId');
    const data: Prisma.MaterialUpdateInput = {};
    const changes: Record<string, unknown> = {};
    if (input.name !== undefined && tidy(input.name) !== m.name) {
      const name = tidy(input.name), key = materialNameKey(name);
      const clash = await ctx.db.material.findFirst({ where: { nameKey: key, NOT: { id: m.id } }, select: { name: true } });
      if (clash) throw new ToolError('MATERIAL_EXISTS', `"${clash.name}" is already in the list.`, undefined, 'name');
      data.name = name; data.nameKey = key; changes.name = name;
    }
    if (input.minimumLevel !== undefined) {
      if (m.stockType !== 'STANDING') throw new ToolError('MINIMUM_NOT_ALLOWED', 'Only material kept in stock has a minimum level.', undefined, 'minimumLevel');
      data.minimumLevel = input.minimumLevel; changes.minimumLevel = qty(input.minimumLevel, m.uom);
    }
    if (input.hsnCode !== undefined) { data.hsnCode = input.hsnCode; changes.hsnCode = input.hsnCode; }
    if (input.gstRate !== undefined) { data.gstRate = input.gstRate; changes.gstRate = `${input.gstRate}%`; }
    if (Object.keys(changes).length === 0) throw new ToolError('NOTHING_TO_CHANGE', 'Nothing to change. Fill in what should be different.');
    const u = await ctx.db.material.update({ where: { id: m.id }, data });
    return {
      data: { name: u.name },
      audit: { entityType: 'Material', entityId: m.id, action: 'UPDATE', before: { name: m.name, minimumLevel: num(m.minimumLevel), hsnCode: m.hsnCode, gstRate: num(m.gstRate) },
        after: { name: u.name, changes, minimumLevel: num(u.minimumLevel), hsnCode: u.hsnCode, gstRate: num(u.gstRate) } },
    };
  },
});

// ── deactivate_material ────────────────────────────────────────────────────────────────────────────
export const deactivateMaterial = defineTool({
  name: 'deactivate_material', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ materialId: id('material'), reason: opt(300) }),
  form: {
    title: 'Stop using a material', verb: 'Stop using it', intro: 'The material stays in the history. It just no longer shows in lists. Only possible when none is left in stock.',
    fields: [
      { name: 'materialId', label: 'Material', type: 'material', required: true },
      { name: 'reason', label: 'Why?', type: 'text', hint: 'In your own words.' },
    ],
  },
  stamp: 'NO LONGER IN USE',
  describe: (a) => [String(a.name), 'It stays in the history but no longer shows in lists.'],
  handler: async (ctx, input) => {
    const m = await ctx.db.material.findUnique({ where: { id: input.materialId }, include: { balance: true } });
    if (!m) throw new ToolError('NOT_FOUND', "Couldn't find that material. Check the spelling.", undefined, 'materialId');
    if (!m.isActive) throw new ToolError('ALREADY_INACTIVE', `"${m.name}" is already no longer in use.`, undefined, 'materialId');
    const left = num(m.balance?.quantity) ?? 0;
    if (left !== 0) throw new ToolError('MATERIAL_HAS_STOCK', `"${m.name}" still has ${qty(left, m.uom)} in stock. It can only be stopped when none is left.`, undefined, 'materialId');
    await ctx.db.material.update({ where: { id: m.id }, data: { isActive: false } });
    return {
      data: { name: m.name },
      audit: { entityType: 'Material', entityId: m.id, action: 'UPDATE', reason: input.reason, before: { name: m.name, isActive: true }, after: { name: m.name, isActive: false } },
    };
  },
});
