import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { checkArtifact, canShare, checkPrintRequest } from './artifact-check';
import { sanitizePrefill } from './prefill';
import { launcherFor, shortcutTool } from './launcher';
import { TOOLS } from './catalog';

const load = (d: string) => readdirSync(new URL(`./examples/${d}`, import.meta.url)).filter((f) => f.endsWith('.html')).map((f) => [f, readFileSync(new URL(`./examples/${d}/${f}`, import.meta.url), 'utf8')] as const);

describe('artifact checker', () => {
  for (const [f, html] of load('good')) it(`accepts good/${f} for the owner`, () => { const r = checkArtifact(html, 'OWNER'); expect(r.issues).toEqual([]); });
  const expected: Record<string, string> = {
    'fetch-exfil.html': 'FORBIDDEN', 'img-beacon.html': 'FORBIDDEN', 'navigate-exfil.html': 'FORBIDDEN', 'parent-reach.html': 'FORBIDDEN',
    'owner-tool.html': 'TOOL_NOT_ALLOWED', 'alias-bridge.html': 'BAD_BRIDGE_USE', 'dynamic-tool.html': 'TOOL_NOT_LITERAL',
    'write-via-read.html': 'TOOL_WRONG_KIND', 'rate-prefill.html': 'RATE_IN_OPENFORM', 'literal-numbers.html': 'LITERAL_NUMBER',
    'storage-form.html': 'FORBIDDEN', 'forged-message.html': 'FORBIDDEN', 'dns-prefetch.html': 'FORBIDDEN', 'navigate-blank.html': 'FORBIDDEN', 'top-nav.html': 'FORBIDDEN', 'dom-link.html': 'FORBIDDEN',
  };
  for (const [f, html] of load('hostile')) {
    if (f === 'flood.html') continue;                          // legal code; stopped by the host's rate limit, tested in host.test.ts
    it(`rejects hostile/${f}`, () => {
      const role = f === 'owner-tool.html' ? 'STOREKEEPER' : 'OWNER';
      const r = checkArtifact(html, role);
      expect(r.ok).toBe(false);
      expect(r.issues.map((i) => i.code)).toContain(expected[f]);
    });
  }
  it('good examples for the storekeeper: stock-value is refused (owner-only)', () => {
    const html = load('good').find(([f]) => f === 'stock-value.html')![1];
    expect(checkArtifact(html, 'STOREKEEPER').issues.map((i) => i.code)).toContain('TOOL_NOT_ALLOWED');
  });
  it('sharing is refused for an owner-only artifact and allowed otherwise', () => {
    const g = Object.fromEntries(load('good'));
    expect(canShare(g['stock-value.html']).ok).toBe(false);
    expect(canShare(g['stock-below-minimum.html']).ok).toBe(true);
  });
  it('flags no-read artifacts and oversize', () => {
    expect(checkArtifact('<p>hi</p>', 'OWNER').issues.map((i) => i.code)).toContain('NO_READ');
    expect(checkArtifact('<script>vijaya.read("list_jobs");</script>' + ' '.repeat(61000), 'OWNER').issues.map((i) => i.code)).toContain('TOO_BIG');
  });
  it('printouts: job-cost-sheet is owner-only; unknown refused', () => {
    expect(checkPrintRequest('job-cost-sheet', 'STOREKEEPER').ok).toBe(false);
    expect(checkPrintRequest('purchase-order', 'STOREKEEPER').ok).toBe(true);
    expect(checkPrintRequest('invoice', 'OWNER').ok).toBe(false);
  });
});

describe('prefill sanitiser', () => {
  it('drops rates, unknown fields and oversize values from agent and artifact', () => {
    for (const origin of ['agent', 'artifact'] as const) {
      const r = sanitizePrefill('create_purchase_order', { supplierName: 'Acme', rate: 5, evil: 1, expectedDate: 'x'.repeat(500), lines: [{ materialId: 'm1', quantity: 3, rate: 99, junk: 1 }] }, origin);
      expect(r.input).toEqual({ supplierName: 'Acme', lines: [{ materialId: 'm1', quantity: 3 }] });
      expect(r.dropped).toEqual(expect.arrayContaining(['rate', 'evil', 'expectedDate', 'lines[0].rate', 'lines[0].junk']));
      expect(r.assisted).toBe(true);
    }
  });
  it('drops the count rate and GRN rate', () => {
    expect(sanitizePrefill('submit_count_line', { stockCountLineId: 'l', unitRate: 4 }, 'agent').input).toEqual({ stockCountLineId: 'l' });
    expect(sanitizePrefill('record_goods_receipt', { supplierId: 's', lines: [{ materialId: 'm', receivedQty: 1, acceptedQty: 1, rate: 2 }] }, 'agent').input).toEqual({ supplierId: 's', lines: [{ materialId: 'm', receivedQty: 1, acceptedQty: 1 }] });
  });
  it('caps lines at 50, rejects non-finite numbers and read tools', () => {
    const lines = Array.from({ length: 80 }, () => ({ materialId: 'm', quantity: 1 }));
    expect((sanitizePrefill('create_purchase_order', { lines }, 'agent').input.lines as unknown[]).length).toBe(50);
    expect(sanitizePrefill('issue_material', { jobId: 'j', lines: [{ materialId: 'm', quantity: Infinity }] }, 'agent').input).toEqual({ jobId: 'j', lines: [{ materialId: 'm' }] });
    expect(sanitizePrefill('list_jobs', { status: 'OPEN' }, 'agent').input).toEqual({});
  });
  it('launcher passes nothing; user input passes through', () => {
    expect(sanitizePrefill('create_job', { quantity: 5 }, 'launcher').input).toEqual({});
    expect(sanitizePrefill('create_job', { quantity: 5 }, 'user').input).toEqual({ quantity: 5 });
  });
  it('never leaves a rate behind for ANY write tool, whatever its name', () => {
    for (const t of Object.values(TOOLS).filter((x) => x.kind === 'write')) {
      const bad: Record<string, unknown> = { rate: 1, unitRate: 1, lines: [{ rate: 1, unitRate: 1 }] };
      const r = JSON.stringify(sanitizePrefill(t.name, bad, 'artifact').input);
      expect(r).not.toMatch(/rate/i);
    }
  });
});

describe('artifact form allow-list and extra rules', () => {
  it('prefill from an artifact for an admin form is dropped entirely', () => {
    for (const tool of ['create_user', 'update_setting', 'approve_purchase_order', 'reverse_movement', 'share_artifact']) expect(sanitizePrefill(tool, { role: 'OWNER', key: 'x' }, 'artifact').input).toEqual({});
    expect(sanitizePrefill('create_user', { name: 'A' }, 'agent').input).toEqual({ name: 'A' });   // the agent may still bring the form; the owner sees it
  });
  it('checker refuses openForm of an admin form', () => {
    expect(checkArtifact(`<script>vijaya.read('list_reorder_alerts');vijaya.openForm('create_user',{});</script>`, 'OWNER').issues.map((i) => i.code)).toContain('TOOL_NOT_ALLOWED');
  });
  it('checker catches a quantity typed inside a script string', () => {
    expect(checkArtifact(`<script>vijaya.read('list_reorder_alerts');vijaya.ui.callout('ok','Stock is 1,200 kg');</script>`, 'OWNER').issues.map((i) => i.code)).toContain('LITERAL_NUMBER');
  });
  it('ui kit forbids ids in chart fields too (host test covers tables)', () => { expect(readFileSync(new URL('./host/uikit.js', import.meta.url), 'utf8')).toContain('noId(o.x)'); });
});

const flat = (l: ReturnType<typeof launcherFor>) => [...l.forms, ...l.moreForms, ...l.chips, ...l.moreChips];
describe('launcher (top used)', () => {
  it('Count becomes Continue count and is pinned first when one is in progress', () => {
    const l = launcherFor('STOREKEEPER', { countInProgress: true, usage: { record_goods_receipt: 99 } });
    expect(l.forms[0].tool).toBe('start_stock_count'); expect(l.forms[0].label).toBe('Continue count');
  });
  it('only offers tools the role may use, and each form button exists', () => {
    for (const role of ['STOREKEEPER', 'OWNER'] as const) for (const i of flat(launcherFor(role))) if (i.kind === 'form') { expect(TOOLS[i.tool].kind).toBe('write'); expect(TOOLS[i.tool].roles).toContain(role); }
  });
  it('owner chips are not shown to the storekeeper, even if his usage says otherwise; no blank prompts', () => {
    const sk = flat(launcherFor('STOREKEEPER', { usage: { 'ask:Stock value': 500, 'ask:Waiting for me': 500 } })).filter((i) => i.kind === 'ask').map((i) => i.label);
    expect(sk).not.toContain('Waiting for me'); expect(sk).not.toContain('Stock value');
    for (const i of flat(launcherFor('OWNER'))) if (i.kind === 'ask') expect(i.prompt.length).toBeGreaterThan(5);
  });
  it('new users get the default order; usage reorders; ties keep default order', () => {
    expect(launcherFor('STOREKEEPER').forms.map((f) => f.tool)).toEqual(['record_goods_receipt', 'issue_material', 'return_material', 'start_stock_count']);
    const l = launcherFor('STOREKEEPER', { usage: { create_job: 7, create_purchase_order: 7, issue_material: 1 } });
    expect(l.forms.map((f) => f.tool)).toEqual(['create_purchase_order', 'create_job', 'issue_material', 'record_goods_receipt']);
  });
  it('caps the row and keeps the rest behind More; nothing is lost', () => {
    const l = launcherFor('OWNER');
    expect(l.forms.length).toBe(4); expect(l.moreForms.length).toBe(2); expect(l.forms.length + l.moreForms.length).toBe(6);
    expect(l.chips.length).toBeLessThanOrEqual(4);
  });
  it('junk usage values are ignored', () => {
    const l = launcherFor('STOREKEEPER', { usage: { create_job: NaN as any, issue_material: -5, return_material: 'x' as any } });
    expect(l.forms.map((f) => f.tool)[0]).toBe('record_goods_receipt');
  });
  it('shortcuts work for every form the role may open, including ones behind More', () => {
    expect(shortcutTool('STOREKEEPER', 'r')).toBe('record_goods_receipt'); expect(shortcutTool('STOREKEEPER', 'j')).toBe('create_job'); expect(shortcutTool('STOREKEEPER', 'z')).toBeUndefined();
  });
});
