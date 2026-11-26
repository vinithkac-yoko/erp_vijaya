import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The sandbox host, the document parser and the renderers run inside the frame and are the safety wall. They are copied
 * from reference/artifacts/host, where the kit tests them in real Chromium. If the copy ever differs by a byte, those
 * tests no longer prove anything about what ships. Change the reference (and its tests) first, then copy.
 */
const same = (name: string) => it(`${name} is the tested original, byte for byte`, () => {
  const a = readFileSync(join(process.cwd(), 'reference/artifacts/host', name), 'utf8');
  const b = readFileSync(join(process.cwd(), 'src/lib/artifacts/host', name), 'utf8');
  expect(b).toBe(a);
});

describe('the sandbox assets that ship are the ones the kit tests', () => {
  for (const f of ['host.js', 'host.d.ts', 'bootstrap.js', 'docrender.js', 'uikit.js', 'vdoc.cjs', 'tokens.css']) same(f);

  it('the sandbox policy is not loosened: no same-origin, no forms, no popups, no downloads, no modals', () => {
    const host = readFileSync(join(process.cwd(), 'src/lib/artifacts/host/host.js'), 'utf8');
    expect(host).toContain(`setAttribute('sandbox', 'allow-scripts')`);
    for (const bad of ['allow-same-origin', 'allow-forms', 'allow-popups', 'allow-top-navigation', 'allow-downloads', 'allow-modals']) expect(host).not.toContain(`'${bad}'`);
    expect(host).toContain("default-src 'none'");
    expect(host).toContain("connect-src 'none'");
  });
});

describe('the guard that stops an artifact nobody asked for', () => {
  it('uses the very words the agent evals check', () => {
    const block = (f: string) => {
      const t = readFileSync(join(process.cwd(), f), 'utf8');
      const a = t.indexOf('new RegExp(['), b = t.indexOf("].join('|'), 'i')");
      return t.slice(a, b).replace(/\s+/g, ' ');
    };
    expect(block('src/lib/artifacts/asked.ts')).toBe(block('evals/assert.ts'));
  });
});
