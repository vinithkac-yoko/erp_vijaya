import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOLS } from '@/lib/catalog';
import { seedDemo } from '@/server/demo/seed';
import { appToolDefs } from '@/server/artifacts/app-tools';
import { registry, runTool } from '@/server/tools';
import { prisma, resetDb } from './helpers/db';
import { owner, seedSettings, storekeeper } from './helpers/tools';

/**
 * The production-readiness audit (docs/SAFETY.md §6, VIJAYA prompt milestone 10). These run against the code and the database as
 * they are, so a change that breaks one of these rules fails here and not in front of the owner.
 */
const root = process.cwd();
const walk = (dir: string, out: string[] = []): string[] => {
  for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); }
  return out;
};
const src = (re: RegExp, dir = 'src') => walk(join(root, dir)).filter((f) => re.test(f));

describe('permissions: every tool has roles, and a storekeeper is offered nothing that is the owner\'s', () => {
  it('every tool declares roles that match the catalog', () => {
    for (const t of registry.list()) {
      expect(t.roles.length, t.name).toBeGreaterThan(0);
      expect([...t.roles].sort(), t.name).toEqual([...(TOOLS[t.name]?.roles ?? [])].sort());
    }
  });
  it('the storekeeper\'s assistant is offered no owner tool, no approval, no reversal, no share, no reset, no report of money', () => {
    const offered = [...registry.forRole('STOREKEEPER').filter((t) => t.agentVisible).map((t) => t.name), ...appToolDefs('STOREKEEPER').map((t) => t.name)];
    const ownerOnly = Object.values(TOOLS).filter((t) => !t.roles.includes('STOREKEEPER')).map((t) => t.name);
    expect(offered.filter((n) => ownerOnly.includes(n))).toEqual([]);
    for (const bad of ['approve_purchase_order', 'reject_purchase_order', 'approve_stock_count', 'reverse_movement', 'update_setting', 'create_user', 'reset_user_password', 'deactivate_user', 'share_artifact', 'unshare_artifact', 'reset_demo_data', 'get_leak_report', 'get_stock_value', 'get_job_cost_report', 'get_activity', 'get_scrap_summary', 'estimate_job_cost', 'list_pending_approvals', 'list_users']) {
      expect(offered, bad).not.toContain(bad);
    }
  });
  it('an internal tool is offered to nobody: not the assistant, not an artifact', () => {
    for (const role of ['OWNER', 'STOREKEEPER'] as const) {
      expect(registry.forRole(role).filter((t) => t.agentVisible).map((t) => t.name)).not.toContain('get_print_data');
    }
  });
});

describe('every route and every server action checks who is asking', () => {
  const OPEN_ON_PURPOSE = new Set([join('src', 'app', 'api', 'health', 'route.ts')]);
  it('each API route reads the session before it does anything (health is the one open door)', () => {
    const routes = src(/route\.ts$/, 'src/app');
    expect(routes.length).toBeGreaterThan(5);
    for (const f of routes) {
      const rel = f.replace(`${root}/`, '');
      if (OPEN_ON_PURPOSE.has(rel)) continue;
      expect(readFileSync(f, 'utf8'), rel).toMatch(/sessionOr401\(|currentUser\(/);
    }
  });
  it('each exported server action looks up the person first (log in and out are the two that cannot)', () => {
    const files = src(/actions\.ts$/).filter((f) => readFileSync(f, 'utf8').startsWith("'use server'"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      const parts = text.split(/\nexport async function /).slice(1);
      for (const p of parts) {
        const name = p.slice(0, p.indexOf('('));
        if (['loginAction', 'logoutAction'].includes(name)) continue;
        expect(p.slice(0, 900), `${f.replace(`${root}/`, '')}: ${name}`).toMatch(/\bwho\(\)|currentUser\(|requireUser\(|getSession\(/);
      }
    }
  });
  it('the app code never imports the database client outside the folders that are allowed to (the lint rule, checked again here)', () => {
    const allowed = [/src\/server\/db\.ts$/, /src\/server\/(tools|auth|artifacts)\//, /src\/server\/(health|guards|errors)\.ts$/, /\.test\.ts$/];
    const offenders = src(/\.(ts|tsx)$/).filter((f) => !allowed.some((a) => a.test(f))).filter((f) => /from ['"](@prisma\/client|@\/server\/db|\.\.?\/(\.\.\/)*db)['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.replace(`${root}/`, ''))).toEqual([]);
  });
});

describe('secrets: none in the code, none in the history, none in the browser bundle', () => {
  const KEY = /sk-ant-[A-Za-z0-9_-]{30,}/;
  const git = (...args: string[]) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch { return null; } };
  it('no API key in any tracked file', () => {
    const files = git('ls-files')?.split('\n').filter(Boolean);
    if (!files) return; // not a git checkout
    const hits = files.filter((f) => { try { return KEY.test(readFileSync(join(root, f), 'utf8')); } catch { return false; } });
    expect(hits).toEqual([]);
  });
  it('no API key was ever committed', () => {
    const log = git('log', '--all', '--oneline', '-G', 'sk-ant-[A-Za-z0-9_-]{30,}');
    if (log === null) return;
    expect(log.trim()).toBe('');
  });
  it('the only environment file in git is the example, and it holds no real value', () => {
    const files = git('ls-files')?.split('\n').filter((f) => /(^|\/)\.env(\.|$)/.test(f));
    if (!files) return;
    expect(files).toEqual(['.env.example']);
    expect(readFileSync(join(root, '.env.example'), 'utf8')).not.toMatch(/sk-ant|postgresql:\/\/[^:\s]+:[^@\s]{4,}@(?!localhost)/);
  });
  it('browser code never reads a secret variable', () => {
    for (const f of src(/\.tsx$/)) {
      const t = readFileSync(f, 'utf8');
      if (!t.startsWith("'use client'")) continue;
      expect(t, f).not.toMatch(/process\.env\.(?!NODE_ENV)[A-Z_]+/);
    }
  });
});

describe('the database: every foreign key has an index, and the demo month is shaped like real use', () => {
  it('every foreign key column has an index that starts with it (so joins and deletes stay fast)', async () => {
    const rows = await prisma.$queryRaw<{ tbl: string; col: string }[]>`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND array_length(c.conkey, 1) = 1
        AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
      ORDER BY 1, 2`;
    expect(rows.map((r) => `${r.tbl}.${r.col}`)).toEqual([]);
  });
});

describe('no id or internal code is ever shown (T10)', () => {
  const ID_LIKE = /^(id|code)$|Id$/;
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const CODE = /\b(MAT|PTY)-\d{3,}\b/;

  it('no read tool lists an id or a code among the fields it lets a table or an artifact show', () => {
    for (const t of Object.values(TOOLS)) for (const f of t.outputs ?? []) expect(f, `${t.name}.${f}`).not.toMatch(ID_LIKE);
  });

  describe('against a real month of data', () => {
    beforeAll(async () => {
      await resetDb(); await seedSettings();
      await seedDemo({ owner: await owner(), storekeeper: await storekeeper() });
    }, 240_000);
    afterAll(() => prisma.$disconnect());

    it('every read tool, run for both people, shows no uuid and no internal code in any word it returns, and draws no id into a card', async () => {
      const seen: string[] = [];
      const bad: string[] = [];
      const scan = (v: unknown, where: string, key = '') => {
        if (typeof v === 'string') { if (!ID_LIKE.test(key) && (UUID.test(v) || CODE.test(v))) bad.push(`${where}.${key}: ${v.slice(0, 60)}`); }
        else if (Array.isArray(v)) v.forEach((x) => scan(x, where, key));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/passwordHash|password_hash/i.test(k)) bad.push(`${where}.${k} (a hash)`); scan(x, where, k); }
      };
      for (const who of [await owner(), await storekeeper()]) {
        for (const t of registry.forRole(who.role).filter((x) => x.kind === 'read' && x.agentVisible)) {
          const out = await runTool(who, t.name, {});
          if (!out.ok) continue;                       // needs an argument: covered by its own tests
          seen.push(`${who.role}:${t.name}`);
          scan(out.data, `${who.role}:${t.name}`);
          const cards = (t as unknown as { view?: (d: unknown) => unknown[] }).view?.(out.data) ?? [];
          expect(JSON.stringify(cards), `${who.role}:${t.name} cards`).not.toMatch(UUID);
          expect(JSON.stringify(cards), `${who.role}:${t.name} cards`).not.toMatch(CODE);
        }
      }
      expect(seen.length).toBeGreaterThan(15);
      expect(bad).toEqual([]);
    }, 120_000);

    it('no list is unbounded: even with hundreds of rows every list and search answers a bounded number', async () => {
      await prisma.material.createMany({ data: Array.from({ length: 600 }, (_, i) => ({ code: `MAT-L${i}`, name: `Bulk Material ${String(i).padStart(3, '0')}`, nameKey: `bulkmaterial${i}`, uom: 'NOS' as const, stockType: 'PER_JOB' as const })) });
      await prisma.party.createMany({ data: Array.from({ length: 400 }, (_, i) => ({ code: `PTY-L${i}`, name: `Bulk Party ${i}`, nameKey: `bulkparty${i}`, isSupplier: true })) });
      const big = { rows: [] as number[] };
      for (const who of [await owner(), await storekeeper()]) {
        for (const t of registry.forRole(who.role).filter((x) => x.kind === 'read' && x.agentVisible)) {
          const out = await runTool(who, t.name, {});
          if (!out.ok) continue;
          const rows = (out.data as { rows?: unknown[] })?.rows;
          if (Array.isArray(rows)) { big.rows.push(rows.length); expect(rows.length, `${who.role}:${t.name}`).toBeLessThanOrEqual(500); }
          expect(JSON.stringify(out.data).length, `${who.role}:${t.name} size`).toBeLessThan(1_500_000);
        }
      }
      expect(big.rows.length).toBeGreaterThan(10);
    }, 120_000);
  });
});
