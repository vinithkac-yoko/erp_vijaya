import { partyNameKey } from '@/lib/names';
import { PARTY, search } from '@/lib/similar';
import { ToolError } from '../errors';
import type { Db } from './types';

export const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The business a form names, by its id (a picker) or by its name (the assistant): exact name first, then the closest.
 * Only active ones, and only of the right kind. A purchase order, a receipt or a customer PO never creates a business.
 */
export async function findParty(db: Db, input: { id?: string; name?: string }, role: 'CUSTOMER' | 'SUPPLIER') {
  const word = role === 'CUSTOMER' ? 'customer' : 'supplier';
  const field = role === 'CUSTOMER' ? 'customerId' : 'supplierId';
  const wrong = (n: string) => new ToolError('PARTY_WRONG_ROLE', `${n} is saved as ${role === 'CUSTOMER' ? 'a supplier' : 'a customer'}, not ${role === 'CUSTOMER' ? 'a customer' : 'a supplier'}. Add the ${word} role to it first.`, undefined, field);
  if (input.id) {
    const p = await db.party.findUnique({ where: { id: input.id } });
    if (!p || !p.isActive) throw new ToolError('PARTY_NOT_FOUND', `Couldn't find that ${word}.`, undefined, field);
    if (role === 'CUSTOMER' ? !p.isCustomer : !p.isSupplier) throw wrong(p.name);
    return p;
  }
  const name = tidy(input.name ?? '');
  if (!name) throw new ToolError('PARTY_NOT_FOUND', `Choose the ${word}.`, undefined, field);
  const all = await db.party.findMany({ where: { isActive: true } });
  const exact = all.find((p) => p.nameKey === partyNameKey(name));
  const hits = exact ? [exact] : search(name, all, (p) => p.nameKey, (p) => p.name, PARTY);
  const only = hits.length === 1 ? hits[0] : undefined;
  if (!only) {
    throw new ToolError('PARTY_NOT_FOUND',
      hits.length ? `Which ${word} is "${name}"? ${hits.slice(0, 4).map((p) => p.name).join(', ')}.` : `Couldn't find "${name}". Add them as a ${word} first.`,
      { suggestions: hits.slice(0, 4).map((p) => p.name) }, field);
  }
  if (role === 'CUSTOMER' ? !only.isCustomer : !only.isSupplier) throw wrong(only.name);
  return only;
}
