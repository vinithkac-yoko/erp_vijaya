import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { normalizeGstin, partyNameKey } from '@/lib/names';
import { isSimilar, PARTY, partyProfile, search } from '@/lib/similar';
import { CHECKS, ToolError } from '../errors';
import { defineTool } from './define';
import { flag, id, opt, pick, req, tidy } from './helpers';
import { nextCode } from './numbers';
import type { WriteResult } from './types';

const ROLES = ['SUPPLIER', 'CUSTOMER', 'BOTH'] as const;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ROWS_IN_CHAT = 10;

type Party = Prisma.PartyGetPayload<object>;
interface PartyResult { id: string; name: string; outcome: 'CREATED' | 'TYPE_ADDED'; isSupplier: boolean; isCustomer: boolean }
export const partyType = (p: Pick<Party, 'isSupplier' | 'isCustomer'>) => (p.isSupplier && p.isCustomer ? 'Supplier and customer' : p.isSupplier ? 'Supplier' : 'Customer');
const row = (p: Party) => ({ id: p.id, name: p.name, type: partyType(p), city: p.city, gstin: p.gstin, phone: p.phone });

/** Checks the details every create and update shares. Messages sit next to the field they belong to. */
function checkDetails(d: { gstin?: string; pincode?: string; email?: string }) {
  if (d.gstin !== undefined && !GSTIN.test(d.gstin)) throw new ToolError('INVALID_GSTIN', (CHECKS.chk_party_gstin as { message: string }).message, undefined, 'gstin');
  if (d.pincode !== undefined && !/^\d{6}$/.test(d.pincode)) throw new ToolError('INVALID_PINCODE', 'A PIN code has 6 digits.', undefined, 'pincode');
  if (d.email !== undefined && !EMAIL.test(d.email)) throw new ToolError('INVALID_EMAIL', 'That does not look like an email address.', undefined, 'email');
}
const gstinInput = z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' ? normalizeGstin(v) : undefined), z.string().max(20).optional());

// ── search_parties ─────────────────────────────────────────────────────────────────────────────────
export const searchParties = defineTool({
  name: 'search_parties', kind: 'read', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ query: opt(100), role: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['SUPPLIER', 'CUSTOMER']).optional()) }),
  handler: async (ctx, input) => {
    let rows = await ctx.db.party.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    if (input.role) rows = rows.filter((p) => (input.role === 'SUPPLIER' ? p.isSupplier : p.isCustomer));
    if (input.query) {
      const g = normalizeGstin(input.query);
      rows = GSTIN.test(g) ? rows.filter((p) => p.gstin === g) : search(input.query, rows, (p) => p.nameKey, (p) => p.name, PARTY);
    }
    return { total: rows.length, rows: rows.slice(0, 100).map(row) };
  },
  view: (d) => [{
    kind: 'table',
    columns: [{ key: 'name', label: 'Name' }, { key: 'type', label: 'Type' }, { key: 'city', label: 'City' }, { key: 'gstin', label: 'GSTIN' }],
    rows: d.rows.slice(0, MAX_ROWS_IN_CHAT).map((r) => ({ name: r.name, type: r.type, city: r.city ?? '–', gstin: r.gstin ?? '–' })),
    note: d.total > MAX_ROWS_IN_CHAT ? `Showing ${MAX_ROWS_IN_CHAT} of ${d.total}.` : undefined,
  }],
});

// ── create_party ───────────────────────────────────────────────────────────────────────────────────
export const createParty = defineTool({
  name: 'create_party', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    name: req('business name', 150), role: pick(ROLES, 'Choose supplier, customer or both.'),
    gstin: gstinInput, city: opt(80), state: opt(80), addressLine: opt(200), pincode: opt(10), phone: opt(30), email: opt(120),
    confirmNotDuplicate: flag.optional(),
  }),
  form: {
    title: 'Add a supplier or customer', verb: 'Add to the list', intro: 'Type only the business name. The city goes in its own box.',
    fields: [
      { name: 'name', label: 'Business name', type: 'text', required: true, hint: 'Like Sundaram Ferrites. No city in the name.' },
      { name: 'role', label: 'They are a', type: 'select', required: true,
        options: [{ value: 'SUPPLIER', label: 'Supplier (we buy from them)' }, { value: 'CUSTOMER', label: 'Customer (we sell to them, or they buy our scrap)' }, { value: 'BOTH', label: 'Both' }] },
      { name: 'gstin', label: 'GSTIN', type: 'text', hint: '15 letters and numbers. If you have it.' },
      { name: 'city', label: 'City', type: 'text' },
      { name: 'state', label: 'State', type: 'text', hint: 'Like Tamil Nadu.' },
      { name: 'addressLine', label: 'Address', type: 'text' },
      { name: 'pincode', label: 'PIN code', type: 'text' },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'email', label: 'Email', type: 'email' },
    ],
  },
  stamp: 'ADDED TO THE LIST',
  stampUpdate: 'ROLE ADDED',
  describe: (a) => [String(a.name), String(a.type), ...(a.city ? [`City: ${a.city}`] : []), ...(a.gstin ? [`GSTIN: ${a.gstin}`] : [])],
  handler: async (ctx, input): Promise<WriteResult<PartyResult>> => {
    const name = tidy(input.name), key = partyNameKey(name);
    if (!key) throw new ToolError('INVALID_INPUT', 'Type the business name.', undefined, 'name');
    checkDetails(input);
    const wantSupplier = input.role !== 'CUSTOMER', wantCustomer = input.role !== 'SUPPLIER';

    const all = await ctx.db.party.findMany();
    const same = all.find((p) => p.nameKey === key);
    if (same) {
      const addSupplier = wantSupplier && !same.isSupplier, addCustomer = wantCustomer && !same.isCustomer;
      if (!addSupplier && !addCustomer) throw new ToolError('PARTY_EXISTS', `"${same.name}" is already saved as ${partyType(same).toLowerCase()}.`, undefined, 'name');
      const u = await ctx.db.party.update({ where: { id: same.id }, data: { isSupplier: same.isSupplier || wantSupplier, isCustomer: same.isCustomer || wantCustomer } });
      return {
        data: { id: u.id, name: u.name, outcome: 'TYPE_ADDED', isSupplier: u.isSupplier, isCustomer: u.isCustomer },
        audit: { entityType: 'Party', entityId: u.id, action: 'UPDATE', before: { name: same.name, type: partyType(same) }, after: { name: u.name, type: partyType(u), city: u.city, gstin: u.gstin } },
      };
    }
    if (input.gstin) {
      const g = all.find((p) => p.gstin === input.gstin);
      if (g) throw new ToolError('PARTY_EXISTS', `That GSTIN is already saved for "${g.name}".`, undefined, 'gstin');
    }
    if (!input.confirmNotDuplicate) {
      const me = partyProfile(name);
      const matches = all.filter((p) => isSimilar(me, partyProfile(p.name))).slice(0, 3);
      if (matches.length) {
        throw new ToolError('SIMILAR_PARTY_EXISTS', `This looks like ${matches.map((m) => `"${m.name}"`).join(' or ')}. Is it the same business?`,
          { matches: matches.map((m) => ({ name: m.name, city: m.city, type: partyType(m) })) }, 'name');
      }
    }
    const p = await ctx.db.party.create({
      data: { code: await nextCode(ctx.db, 'PTY'), name, nameKey: key, isSupplier: wantSupplier, isCustomer: wantCustomer, gstin: input.gstin,
        city: input.city, state: input.state, addressLine: input.addressLine, pincode: input.pincode, phone: input.phone, email: input.email?.toLowerCase() },
    });
    return {
      data: { id: p.id, name: p.name, outcome: 'CREATED', isSupplier: p.isSupplier, isCustomer: p.isCustomer },
      audit: { entityType: 'Party', entityId: p.id, action: 'CREATE', after: { name: p.name, type: partyType(p), city: p.city, gstin: p.gstin, state: p.state } },
    };
  },
  followUps: async (_ctx, _input, result) => {
    const r = result as { id: string; name: string; isSupplier?: boolean; isCustomer?: boolean };
    return {
      facts: [],
      chips: [
        ...(r.isSupplier ? [{ label: `Raise a purchase order to ${r.name}`, form: 'create_purchase_order', prefill: { supplierId: r.id } }] : []),
        ...(r.isCustomer ? [{ label: 'Record a customer PO', form: 'create_customer_po', prefill: { customerName: r.name } }] : []),
      ],
    };
  },
});

// ── update_party ───────────────────────────────────────────────────────────────────────────────────
export const updateParty = defineTool({
  name: 'update_party', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({
    partyId: id('business'), name: opt(150), gstin: gstinInput, city: opt(80), state: opt(80), addressLine: opt(200), pincode: opt(10), phone: opt(30), email: opt(120),
    addRole: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['SUPPLIER', 'CUSTOMER']).optional()),
  }),
  form: {
    title: 'Change a supplier or customer', verb: 'Save changes', intro: 'Leave a box empty to keep what is there. A role can be added, never taken away.',
    fields: [
      { name: 'partyId', label: 'Business', type: 'party', required: true },
      { name: 'name', label: 'New name', type: 'text', hint: 'Only if it changed.' },
      { name: 'addRole', label: 'Also a', type: 'select', options: [{ value: '', label: '(no change)' }, { value: 'SUPPLIER', label: 'Supplier' }, { value: 'CUSTOMER', label: 'Customer' }] },
      { name: 'gstin', label: 'GSTIN', type: 'text' }, { name: 'city', label: 'City', type: 'text' }, { name: 'state', label: 'State', type: 'text' },
      { name: 'addressLine', label: 'Address', type: 'text' }, { name: 'pincode', label: 'PIN code', type: 'text' },
      { name: 'phone', label: 'Phone', type: 'text' }, { name: 'email', label: 'Email', type: 'email' },
    ],
  },
  stamp: 'DETAILS CHANGED',
  describe: (a) => [String(a.name), ...((a.changed as string[] | undefined) ?? [])],
  handler: async (ctx, input) => {
    const p = await ctx.db.party.findUnique({ where: { id: input.partyId } });
    if (!p) throw new ToolError('NOT_FOUND', "Couldn't find that business. Check the spelling.", undefined, 'partyId');
    checkDetails(input);
    const data: Prisma.PartyUpdateInput = {};
    const changed: string[] = [];
    if (input.name !== undefined && tidy(input.name) !== p.name) {
      const name = tidy(input.name), key = partyNameKey(name);
      const clash = await ctx.db.party.findFirst({ where: { nameKey: key, NOT: { id: p.id } }, select: { name: true } });
      if (clash) throw new ToolError('PARTY_EXISTS', `"${clash.name}" is already saved.`, undefined, 'name');
      data.name = name; data.nameKey = key; changed.push(`Name: ${name}`);
    }
    if (input.gstin !== undefined && input.gstin !== p.gstin) {
      const clash = await ctx.db.party.findFirst({ where: { gstin: input.gstin, NOT: { id: p.id } }, select: { name: true } });
      if (clash) throw new ToolError('PARTY_EXISTS', `That GSTIN is already saved for "${clash.name}".`, undefined, 'gstin');
      data.gstin = input.gstin; changed.push(`GSTIN: ${input.gstin}`);
    }
    for (const [k, label] of [['city', 'City'], ['state', 'State'], ['addressLine', 'Address'], ['pincode', 'PIN code'], ['phone', 'Phone']] as const) {
      if (input[k] !== undefined && input[k] !== p[k]) { (data as Record<string, unknown>)[k] = input[k]; changed.push(`${label}: ${input[k]}`); }
    }
    if (input.email !== undefined && input.email.toLowerCase() !== p.email) { data.email = input.email.toLowerCase(); changed.push(`Email: ${input.email.toLowerCase()}`); }
    if (input.addRole === 'SUPPLIER' && !p.isSupplier) { data.isSupplier = true; changed.push('Also a supplier'); }
    if (input.addRole === 'CUSTOMER' && !p.isCustomer) { data.isCustomer = true; changed.push('Also a customer'); }
    if (changed.length === 0) throw new ToolError('NOTHING_TO_CHANGE', 'Nothing to change. Fill in what should be different.');
    const u = await ctx.db.party.update({ where: { id: p.id }, data });
    return {
      data: { name: u.name },
      audit: { entityType: 'Party', entityId: p.id, action: 'UPDATE', before: { name: p.name, type: partyType(p), city: p.city, gstin: p.gstin }, after: { name: u.name, type: partyType(u), city: u.city, gstin: u.gstin, changed } },
    };
  },
});

// ── deactivate_party ───────────────────────────────────────────────────────────────────────────────
export const deactivateParty = defineTool({
  name: 'deactivate_party', kind: 'write', roles: ['STOREKEEPER', 'OWNER'],
  input: z.object({ partyId: id('business'), reason: opt(300) }),
  form: {
    title: 'Stop using a supplier or customer', verb: 'Stop using them', intro: 'They stay in the history. Not possible while they have open purchase orders, customer POs or jobs.',
    fields: [{ name: 'partyId', label: 'Business', type: 'party', required: true }, { name: 'reason', label: 'Why?', type: 'text', hint: 'In your own words.' }],
  },
  stamp: 'NO LONGER IN USE',
  describe: (a) => [String(a.name), 'They stay in the history but no longer show in lists.'],
  handler: async (ctx, input) => {
    const p = await ctx.db.party.findUnique({ where: { id: input.partyId } });
    if (!p) throw new ToolError('NOT_FOUND', "Couldn't find that business. Check the spelling.", undefined, 'partyId');
    if (!p.isActive) throw new ToolError('ALREADY_INACTIVE', `"${p.name}" is already no longer in use.`, undefined, 'partyId');
    const [pos, cpos, jobs] = await Promise.all([
      ctx.db.purchaseOrder.count({ where: { supplierId: p.id, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED'] } } }),
      ctx.db.customerPo.count({ where: { customerId: p.id, status: 'OPEN' } }),
      ctx.db.job.count({ where: { customerId: p.id, status: { notIn: ['CLOSED', 'CANCELLED'] } } }),
    ]);
    if (pos + cpos + jobs > 0) {
      const parts = [pos && `${pos} open purchase order${pos > 1 ? 's' : ''}`, cpos && `${cpos} open customer PO${cpos > 1 ? 's' : ''}`, jobs && `${jobs} open job${jobs > 1 ? 's' : ''}`].filter(Boolean);
      throw new ToolError('PARTY_IN_USE', `"${p.name}" still has ${parts.join(', ')}.`, undefined, 'partyId');
    }
    await ctx.db.party.update({ where: { id: p.id }, data: { isActive: false } });
    return { data: { name: p.name }, audit: { entityType: 'Party', entityId: p.id, action: 'UPDATE', reason: input.reason, before: { name: p.name, isActive: true }, after: { name: p.name, isActive: false } } };
  },
});
