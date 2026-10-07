/**
 * Spelling-tolerant matching for names (INTERFACE §6: "ferite core e30" finds "Ferrite Core E-30").
 * Pure functions, no database. The tools load the candidates and ask these who matches.
 */
import { materialNameKey, partyNameKey } from './names';

/** Edit distance where swapping two neighbouring letters costs 1 ("wier" → "wire"). */
export function distance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev2: number[] = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, (prev2[j - 2] as number) + 1);
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n] as number;
}

/** The smallest distance between `query` and ANY stretch of `text` (so a short query can sit inside a long name). */
export function distanceWithin(query: string, text: string): number {
  const m = query.length, n = text.length;
  if (m === 0) return 0;
  if (n === 0) return m;
  let prev2: number[] = [];
  let prev = new Array<number>(n + 1).fill(0); // a match may start anywhere in the text for free
  prev[0] = 0;
  let row0 = 0;
  for (let i = 1; i <= m; i++) {
    row0 = i;
    const cur = [row0];
    for (let j = 1; j <= n; j++) {
      const cost = query[i - 1] === text[j - 1] ? 0 : 1;
      let v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && query[i - 1] === text[j - 2] && query[i - 2] === text[j - 1]) v = Math.min(v, (prev2[j - 2] as number) + 1);
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return Math.min(...prev);
}

/** How many slips we forgive for a query of this length. Very short queries must match exactly. */
const allowed = (len: number) => (len <= 3 ? 0 : len <= 7 ? 1 : 2);

const words = (s: string) => s.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** How a kind of name is boiled down for comparing: a business drops "M/s" and "Pvt Ltd", a material does not. */
export interface Profile { key: (s: string) => string; words: (s: string) => string[] }
const SUFFIX = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'inc', 'corp', 'corporation', 'm', 's']);
export const MATERIAL: Profile = { key: materialNameKey, words: (s) => words(s).map(materialNameKey) };
export const PARTY: Profile = { key: partyNameKey, words: (s) => words(s).filter((w) => !SUFFIX.has(w)) };

/** 0 = the name contains what was typed, 1–2 = it does after forgiving slips, null = no match. Lower is better. */
export function matchRank(query: string, nameKey: string, profile: Profile = MATERIAL): number | null {
  const qk = profile.key(query);
  if (!qk) return 0;
  if (nameKey.includes(qk)) return 0;
  const whole = distanceWithin(qk, nameKey);
  if (whole <= allowed(qk.length)) return whole;
  // "wire 22 swg" finds "22 SWG Copper Wire": every word the user typed must be there, in any order
  const ws = profile.words(query).filter((w) => w.length >= 1);
  if (ws.length > 1) {
    let worst = 0;
    for (const w of ws) {
      if (nameKey.includes(w)) continue;
      const d = distanceWithin(w, nameKey);
      if (d > allowed(w.length)) return null;
      worst = Math.max(worst, d);
    }
    return 1 + worst;
  }
  return null;
}

export function search<T>(query: string, items: T[], keyOf: (t: T) => string, nameOf: (t: T) => string, profile: Profile = MATERIAL): T[] {
  return items
    .map((it) => ({ it, r: matchRank(query, keyOf(it), profile) }))
    .filter((x): x is { it: T; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r || nameOf(a.it).localeCompare(nameOf(b.it)))
    .map((x) => x.it);
}

const digitRuns = (key: string) => (key.match(/\d+/g) ?? []).join('.');

/**
 * "Is this the same as something we already have?" Close but not identical.
 *  – the same words in a different order ("Copper Wire 22 SWG" / "22 SWG Copper Wire"), or
 *  – a slip or a missing letter ("Sundaram Ferrite" / "Sundaram Ferrites").
 * Different NUMBERS are never "similar": 22 SWG and 24 SWG wire are different materials, and asking every time would
 * teach people to tick "different" without reading.
 */
export function isSimilar(a: { key: string; words: string[] }, b: { key: string; words: string[] }): boolean {
  if (a.key === b.key) return false; // identical is a different case (already exists)
  if (digitRuns(a.key) !== digitRuns(b.key)) return false;
  if ([...a.words].sort().join('|') === [...b.words].sort().join('|')) return true;
  const slack = a.key.length >= 14 ? 2 : a.key.length >= 8 ? 1 : 0;
  return slack > 0 && distance(a.key, b.key) <= slack;
}

export const materialProfile = (name: string) => ({ key: MATERIAL.key(name), words: MATERIAL.words(name) });
export const partyProfile = (name: string) => ({ key: PARTY.key(name), words: PARTY.words(name) });
