import type { Prisma } from '@prisma/client';
import type { Db } from './types';

/**
 * The questions for the owner come from docs/CLIENT_CONFIRMATIONS.md, the file Kasi and the builder keep up to date. This reads
 * its question tables into rows; the owner's answers live in the database and are never touched by a re-import. Nothing here
 * is shown to a person with its key ("A1", "M11") on it.
 */
export interface Choice { value: string; label: string; /** He must write something with this choice ("Change: …"). */ writeIn?: boolean }
export interface ParsedDecision { key: string; topic: string; position: number; question: string; whatWeDid: string; why: string | null; options: Choice[]; agreedByKasi: boolean; firstPass: boolean }

/** The ones to put to the owner first: what the next pieces of work wait on (Kasi, 2026-10-23: "ok"). */
export const FIRST_PASS = new Set(['J13', 'K1', 'K5', 'L1', 'L2', 'L4', 'L6', 'L7', 'L9', 'L10', 'M3', 'M4', 'M5', 'M7', 'M8', 'M10', 'M11', 'M12', 'M17', 'M19']);

const plain = (s: string) => s.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'answer';
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function topicOf(title: string): string {
  const t = plain(title);
  if (/^added/i.test(t)) return cap(t.split(/\s[—–]\s|:\s/).slice(1).join(' — ').trim() || t);
  return cap(t.split(/\s[—–]\s/)[0] ?? t);
}

/** "☐ OK ☐ Change: ___" → OK, Change (write something). No boxes and a blank → the usual two. A prompt with a colon → write in his own words. */
export function parseOptions(cell: string): Choice[] {
  const c = plain(cell);
  if (c.includes('☐')) {
    const out: Choice[] = [];
    for (const chunk of c.split('☐').map((x) => x.trim()).filter(Boolean)) {
      const m = /^([^:_]+?)\s*:\s*[_\s]*(.*)$/.exec(chunk);
      const label = (m ? m[1]! : chunk.replace(/[_\s]+$/g, '')).trim();
      if (!label) continue;
      let value = slug(label);
      while (out.some((o) => o.value === value)) value += '_2';
      out.push({ value, label, ...(m ? { writeIn: true } : {}) });
    }
    if (out.length) return out.slice(0, 6);
  }
  if (!c || /^[_\s]*$/.test(c)) return [{ value: 'ok', label: 'OK, keep it as it is' }, { value: 'change', label: 'Change it', writeIn: true }];
  return [{ value: 'answer', label: c.replace(/[:_\s]+$/g, '') || 'Your answer', writeIn: true }];
}

const cells = (line: string) => line.replace(/\\\|/g, '\u0000').split('|').slice(1, -1).map((c) => c.replace(/\u0000/g, '|').trim());

export function parseConfirmations(md: string): ParsedDecision[] {
  const out: ParsedDecision[] = [];
  let topic = '';
  let header: string[] | null = null;
  let position = 0;
  for (const line of md.split('\n')) {
    const h = /^## ([A-Z])\.\s+(.+)$/.exec(line);
    if (h) { topic = topicOf(h[2]!); header = null; continue; }
    if (/^###? /.test(line)) { header = null; continue; }
    if (line.startsWith('| #')) { header = cells(line).map((c) => c.toLowerCase()); continue; }
    if (!header || !line.startsWith('|') || !header.some((c) => c.includes('question'))) continue;
    const c = cells(line);
    const key = /^([A-Z]\d+)$/.exec(c[0] ?? '')?.[1];
    if (!key) continue;
    const at = (name: string) => { const i = header!.findIndex((x) => x === name || x.startsWith(name)); return i >= 0 ? c[i] ?? '' : ''; };
    const status = at('status');
    const done = at('what we did');
    const why = at('why');
    const owner = at('owner says');
    out.push({
      key, topic, position: position++, question: plain(at('the question')), whatWeDid: plain(done), why: why ? plain(why) : null,
      options: parseOptions(owner), agreedByKasi: status.includes('✅'), firstPass: FIRST_PASS.has(key),
    });
  }
  return out;
}

/** Puts the questions in the database: new ones are added, the wording of known ones is brought up to date, answers are never touched. */
export async function importDecisions(db: Db, md: string): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  for (const d of parseConfirmations(md)) {
    const data = { topic: d.topic, position: d.position, question: d.question, whatWeDid: d.whatWeDid, why: d.why, options: d.options as unknown as Prisma.InputJsonValue, agreedByKasi: d.agreedByKasi, firstPass: d.firstPass };
    const found = await db.decision.findUnique({ where: { key: d.key }, select: { id: true } });
    if (found) { await db.decision.update({ where: { key: d.key }, data }); updated++; } else { await db.decision.create({ data: { key: d.key, ...data } }); added++; }
  }
  return { added, updated };
}
