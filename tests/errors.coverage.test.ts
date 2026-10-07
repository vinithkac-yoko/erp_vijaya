import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { mapConstraint, mapError, ToolError, TRIGGER_CODES, UNKNOWN_CONSTRAINT } from '@/server/errors';
import { ZodError, z } from 'zod';
import { expectPlain, prisma } from './helpers/db';

afterAll(() => prisma.$disconnect());

/** T18: a test walks the database. A constraint nobody wrote words for fails here, not in front of the storekeeper. */
describe('error mapping covers the whole database', () => {
  it('every CHECK, UNIQUE and FOREIGN KEY constraint has an entry', async () => {
    const rows = await prisma.$queryRaw<{ conname: string; contype: string }[]>`
      SELECT conname, contype::text FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND contype IN ('c','u','f','p')`;
    expect(rows.length).toBeGreaterThan(50);
    const unmapped = rows.filter((r) => !mapConstraint(r.conname)).map((r) => `${r.contype}:${r.conname}`);
    expect(unmapped).toEqual([]);
    // …and none of them falls back to the vague catch-all, apart from keys that can never fail for a person.
    for (const r of rows.filter((x) => x.contype === 'c' || x.contype === 'u')) {
      const m = mapConstraint(r.conname) as { code: string; message: string };
      if (m.code !== 'INTERNAL') expectPlain(m);
    }
  });

  it('every unique INDEX (including the ones Prisma and our migration make without a constraint) has an entry', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE INDEX%'`;
    expect(rows.map((r) => r.indexname).filter((n) => !mapConstraint(n))).toEqual([]);
  });

  it('every CODE: a migration can RAISE has plain words', () => {
    const dir = join(process.cwd(), 'prisma/migrations');
    const raised = new Set<string>();
    for (const d of readdirSync(dir)) {
      let sql = '';
      try { sql = readFileSync(join(dir, d, 'migration.sql'), 'utf8'); } catch { continue; }
      for (const m of sql.matchAll(/RAISE EXCEPTION\s+'([A-Z][A-Z_]+):/g)) raised.add(m[1] as string);
    }
    expect(raised.size).toBeGreaterThan(10);
    expect([...raised].filter((c) => !(c in TRIGGER_CODES))).toEqual([]);
    for (const c of raised) expectPlain(TRIGGER_CODES[c] as { code: string; message: string });
  });

  it('every message in the table is plain: no database words, no codes, no ids', () => {
    for (const [name, m] of [...Object.entries(TRIGGER_CODES)]) {
      expectPlain(m);
      expect(m.message, name).not.toMatch(/MAT-|PTY-/);
    }
  });
});

describe('mapError', () => {
  it('passes a tool error through, and turns a validation error into its first plain message', () => {
    expect(mapError(new ToolError('JOB_NOT_OPEN', 'That job is already running.'))).toEqual({ code: 'JOB_NOT_OPEN', message: 'That job is already running.' });
    const parsed = z.object({ qty: z.number({ required_error: 'How much?' }) }).safeParse({});
    expect(mapError((parsed as { error: ZodError }).error)).toEqual({ code: 'INVALID_INPUT', message: 'How much?' });
  });

  it('never leaks the raw database text of something unexpected', () => {
    for (const raw of [new Error('connection refused at 10.0.0.5:5432 password=hunter2'), 'plain string', null, new Prisma.PrismaClientUnknownRequestError('boom relation "users" does not exist', { clientVersion: '6' })]) {
      const m = mapError(raw);
      expect(m).toEqual(UNKNOWN_CONSTRAINT);
      expect(JSON.stringify(m)).not.toMatch(/hunter2|10\.0\.0\.5|relation|users/);
    }
  });

  it('a trigger message the table does not know is shown as the vague one, not as raw text', () => {
    const err = new Prisma.PrismaClientKnownRequestError('x', { code: 'P2010', clientVersion: '6', meta: { code: 'P0001', message: 'ERROR: SOMETHING_NEW: secret internals' } });
    expect(mapError(err)).toEqual(UNKNOWN_CONSTRAINT);
  });
});
