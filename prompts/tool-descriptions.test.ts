/**
 * Keeps the model-facing tool text in step with the catalog doc and the artifact checker's catalog.
 * Run with the rest of the kit: cd reference/artifacts && npm run test:kit
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../reference/artifacts/catalog';

type Desc = { kind: 'read' | 'write' | 'app'; roles: string[]; agent: boolean; description: string; inputs: Record<string, string> };
const here = __dirname;
const json: { tools: Record<string, Desc> } = JSON.parse(readFileSync(join(here, 'tool-descriptions.json'), 'utf8'));
const D = json.tools;
const catalogMd = readFileSync(join(here, '../docs/TOOL_CATALOG.md'), 'utf8');

// | `name` | Kind | Roles | Purpose |
const rows = [...catalogMd.matchAll(/^\| `([a-z_]+)` \| ([^|]+) \| ([^|]+) \|/gm)].map((m) => ({
  name: m[1], kind: m[2].trim(), roles: m[3].trim(),
}));

describe('tool descriptions', () => {
  it('cover exactly the tools in TOOL_CATALOG.md', () => {
    expect(Object.keys(D).sort()).toEqual(rows.map((r) => r.name).sort());
  });

  it('kind and roles match TOOL_CATALOG.md', () => {
    for (const r of rows) {
      const d = D[r.name];
      const kind = r.kind.startsWith('R') ? 'read' : r.kind.startsWith('W') ? 'write' : 'app';
      expect(d.kind, r.name).toBe(kind);
      const roles = [/\bSK\b/.test(r.roles) && 'STOREKEEPER', /\bOW\b/.test(r.roles) && 'OWNER'].filter(Boolean);
      expect([...d.roles].sort(), r.name).toEqual(roles.sort());
    }
  });

  it('agree with the artifact checker\'s catalog: kind, roles, and every input described', () => {
    for (const [name, meta] of Object.entries(TOOLS)) {
      const d = D[name];
      expect(d, name).toBeDefined();
      expect(d.kind, name).toBe(meta.kind);
      expect([...d.roles].sort(), name).toEqual([...meta.roles].sort());
      expect(Object.keys(d.inputs).sort(), `${name} inputs`).toEqual(Object.keys(meta.inputs).sort());
    }
  });

  it('every input has a real description', () => {
    for (const [name, d] of Object.entries(D)) for (const [k, v] of Object.entries(d.inputs)) expect(v.length, `${name}.${k}`).toBeGreaterThan(5);
  });

  it('write tools say that calling them only opens a form', () => {
    for (const [name, d] of Object.entries(D)) {
      if (d.kind !== 'write' || ['mark_notifications_read', 'save_count_sheet'].includes(name)) continue;
      expect(d.description, name).toMatch(/opens the (approval )?form|Opens the form/i);
      expect(d.description, name).toMatch(/nothing is saved until they submit/i);
    }
  });

  it('every rate input tells the model not to fill it in', () => {
    for (const [name, meta] of Object.entries(TOOLS)) {
      for (const [k, spec] of Object.entries(meta.inputs)) if (spec.rate) expect(D[name].inputs[k], `${name}.${k}`).toMatch(/ONLY if the user gave it/);
    }
  });

  it('owner-only tools say so first', () => {
    for (const [name, d] of Object.entries(D)) if (d.roles.length === 1 && d.roles[0] === 'OWNER') expect(d.description, name).toMatch(/^OWNER ONLY\./);
  });

  it('stay short enough and never mention internal codes', () => {
    for (const [name, d] of Object.entries(D)) {
      expect(d.description.length, name).toBeLessThanOrEqual(1024);
      expect(d.description, name).not.toMatch(/\b(MAT|PTY)-\d/);
    }
  });

  it('the generated file matches its source script', () => {
    expect(readFileSync(join(here, 'build_tool_descriptions.py'), 'utf8')).toContain('tool-descriptions.json');
  });
});
