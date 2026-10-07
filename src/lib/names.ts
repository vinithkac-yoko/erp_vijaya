/**
 * Name keys: how the system decides two names are the same thing. The database holds them UNIQUE, so a duplicate is
 * refused even if some code forgets to check. Only these functions may compute a key — never set one by hand.
 */

const clean = (s: string) => s.normalize('NFKC').toLowerCase();

/** "22 SWG Copper Wire" and "22 swg copper-wire" → "22swgcopperwire". Word order still matters. */
export function materialNameKey(name: string): string {
  return clean(name).replace(/[^\p{L}\p{N}]/gu, '');
}

const COMPANY_SUFFIX = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'inc', 'incorporated', 'corp', 'corporation']);

/** "M/s Sundaram Ferrites Pvt. Ltd." → "sundaramferrites". */
export function partyNameKey(name: string): string {
  const s = clean(name).replace(/^\s*m\s*\/\s*s\b\.?/, ' ');
  const words = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const kept = [...words];
  while (kept.length > 1 && COMPANY_SUFFIX.has(kept[kept.length - 1] as string)) kept.pop();
  return kept.join('');
}

/** GSTIN is stored uppercase with no spaces. */
export function normalizeGstin(g: string): string {
  return g.replace(/\s+/g, '').toUpperCase();
}
