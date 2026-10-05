/**
 * Documents (VDoc): reports, memos, SOPs and diagrams. Unit tests for the parser/checker, then real Chromium for what
 * the renderer draws, the truth test (shown numbers == read results), the diagram, and hostile content that skips the
 * checker entirely.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page, type Frame } from 'playwright-core';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { TOOLS, readToolsFor, artifactFormsFor, type Role } from './catalog';
import { checkDoc, canShareDoc } from './artifact-check';

const VDoc = createRequire(import.meta.url)('./host/vdoc.cjs');
const rd = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const doc = (d: string, f: string) => rd(`./examples/${d}/${f}.vdoc`);
const hostJs = rd('./host/host.js'), boot = rd('./host/bootstrap.js'), kit = rd('./host/uikit.js'), tokens = rd('./host/tokens.css'), vdocJs = rd('./host/vdoc.cjs'), renderJs = rd('./host/docrender.js');
const mermaidJs = rd('./node_modules/mermaid/dist/mermaid.min.js');
const chrome = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', ...(existsSync('/opt/pw-browsers') ? readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-')).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`) : [])].find(existsSync);

const codes = (src: string, role: Role = 'OWNER') => checkDoc(src, role).issues.map((i) => i.code);

describe('VDoc parser and checker', () => {
  it('good documents pass for the owner; the SOP needs no reads', () => {
    expect(checkDoc(doc('good', 'stock-report'), 'OWNER').issues).toEqual([]);
    const sop = checkDoc(doc('good', 'receiving-sop'), 'STOREKEEPER');
    expect(sop.issues).toEqual([]); expect(sop.reads).toEqual([]); expect(sop.usesMermaid).toBe(true);
  });
  it('the stock report uses owner-only data, so it cannot be shared; the SOP can', () => {
    expect(canShareDoc(doc('good', 'stock-report')).ok).toBe(false);
    expect(canShareDoc(doc('good', 'receiving-sop')).ok).toBe(true);
  });
  it('a storekeeper cannot even write a document that reads an owner-only tool', () => { expect(codes(doc('hostile', 'doc-owner-tool'), 'STOREKEEPER')).toContain('TOOL_NOT_ALLOWED'); });
  it('write tools in the header are refused', () => { expect(codes(doc('hostile', 'doc-write-read'))).toContain('TOOL_WRONG_KIND'); });
  it('typed amounts and quantities are refused', () => { expect(codes(doc('hostile', 'doc-literal-numbers'))).toContain('LITERAL_NUMBER'); });
  it('HTML and links are refused', () => { const c = codes(doc('hostile', 'doc-html-links')); expect(c).toContain('HTML_IN_DOC'); expect(c).toContain('LINK_IN_DOC'); });
  it('mermaid script/click/href/init is refused', () => { expect(codes(doc('hostile', 'doc-mermaid-injection'))).toContain('DOC_INVALID'); });
  it('a rate in a row button prefill is refused', () => { expect(codes(doc('hostile', 'doc-rate-prefill'))).toContain('RATE_IN_OPENFORM'); });
  it('a row button cannot open an admin form', () => { expect(codes(doc('hostile', 'doc-admin-form'))).toContain('TOOL_NOT_ALLOWED'); });
  it('undeclared reads and internal id fields are refused', () => {
    const r = checkDoc(doc('hostile', 'doc-ids-and-undeclared'), 'OWNER').issues.map((i) => i.message).join(' ');
    expect(r).toMatch(/ghost/); expect(r).toMatch(/internal/);
  });
  it('unknown formats and broken JSON are reported, not thrown', () => {
    expect(codes('---\ntitle: x\nreads:\n  a: list_jobs {}\n---\n{{a.count|bogus}}\n```vtable\n{nope\n```')).toContain('DOC_INVALID');
  });
  it('too big is refused', () => { expect(codes('---\ntitle: x\n---\n' + 'word '.repeat(20000))).toContain('TOO_BIG'); });
  it('toMarkdown resolves bindings, tables and stats with Indian grouping', () => {
    const md = VDoc.toMarkdown(VDoc.parse(doc('good', 'stock-report')), {
      alerts: { rows: [{ material: 'Copper wire', unit: 'kg', onHand: 12.5, shortfall: 1300 }] }, value: { rows: [{ material: 'Copper', value: 8125 }], total: 1234567 } });
    expect(md).toContain('₹12,34,567'); expect(md).toContain('1,300 kg'); expect(md).toContain('# Stock position'); expect(md).toContain('**1**');
  });
});

const ALERTS = { rows: [
  { material: 'Copper wire 0.5mm', unit: 'kg', onHand: 12.5, minimumLevel: 50, shortfall: 37.5, materialId: 'm1' },
  { material: '<img src=https://evil.test/db onerror=alert(1)>', unit: 'kg', onHand: 1200, minimumLevel: 2500, shortfall: 1300, materialId: 'm2' },
] };
const VALUE = { rows: [{ material: 'Copper wire 0.5mm', quantity: 10, value: 8125 }, { material: 'CRGO', quantity: 5, value: 1226442 }], total: 1234567 };
const NONCE = 'n0nce123';
const PARENT_CSP = `default-src 'none'; script-src 'self' 'nonce-${NONCE}'; style-src 'unsafe-inline'; frame-src about:; connect-src 'none'; img-src data:; base-uri 'none'; form-action 'none'`;

let browser: Browser;
beforeAll(async () => { if (chrome) browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] }); }, 30000);
afterAll(async () => { await browser?.close(); });

async function runDoc(source: string, role: Role) {
  const ctx = await browser.newContext(), page = await ctx.newPage();
  const leaked: string[] = [], forms: { tool: string; prefill: any }[] = [], serverCalls: string[] = [];
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.host === 'app.test' && u.pathname === '/') return route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': PARENT_CSP }, body:
      `<!doctype html><title>app</title><div id="box" style="width:800px;height:900px"></div><script nonce="${NONCE}" type="module">
        import { mountArtifact } from '/host.js';
        window.__mount = (cfg) => { window.__m = mountArtifact({ ...cfg, nonce: '${NONCE}', allowedRead: new Set(cfg.allowedRead), allowedWrite: new Set(cfg.allowedWrite), container: document.getElementById('box'),
          runRead: (t, i) => window.__runRead(t, i), onOpenForm: (t, p) => window.__openForm(t, p), onEvent: () => {} }); }; window.__ready = true;</script>` });
    if (u.host === 'app.test' && u.pathname === '/host.js') return route.fulfill({ contentType: 'text/javascript', body: hostJs });
    if (u.host === 'app.test') return route.fulfill({ status: 404, body: '' });
    leaked.push(route.request().url()); return route.abort();
  });
  await page.exposeFunction('__runRead', (tool: string) => { serverCalls.push(tool); const m = TOOLS[tool]; if (!m || m.kind !== 'read' || !m.roles.includes(role)) throw new Error('forbidden'); return tool === 'get_stock_value' ? VALUE : ALERTS; });
  await page.exposeFunction('__openForm', (tool: string, prefill: any) => { forms.push({ tool, prefill }); });
  await page.goto('http://app.test/'); await page.waitForFunction('window.__ready === true');
  await page.evaluate((c) => (window as any).__mount(c), { kind: 'document', source, vdocSource: vdocJs, docRenderSource: renderJs, mermaidSource: mermaidJs, tokensCss: tokens, bootstrapSource: boot, uiKitSource: kit, theme: 'light', user: { role }, title: 'Doc', allowedRead: [...readToolsFor(role)], allowedWrite: [...artifactFormsFor(role)] });
  const frame = () => page.frames().find((f) => f !== page.mainFrame()) as Frame;
  await page.waitForFunction(() => true);
  for (let i = 0; i < 60; i++) { const s = await frame()?.evaluate(() => document.documentElement.getAttribute('data-vdoc')).catch(() => null); if (s) break; await page.waitForTimeout(200); }
  return { page, frame, leaked, forms, serverCalls, close: () => ctx.close() };
}

describe.skipIf(!chrome)('documents in real Chromium', () => {
  it('truth test: every number on the page equals the read result, formatted by the kit', async () => {
    const r = await runDoc(doc('good', 'stock-report'), 'OWNER');
    const text = await r.frame().evaluate(() => document.body.innerText);
    expect(text).toContain('₹12,34,567');                    // total, Indian grouping
    expect(text).toContain('2 materials are below');         // alerts.count = rows.length
    const rows = await r.frame().locator('tbody tr').allInnerTexts();
    expect(rows[0]).toContain('Copper wire 0.5mm'); expect(rows[0]).toContain('12.5'); expect(rows[0]).toContain('37.5');
    expect(rows[1]).toContain('1,200'); expect(rows[1]).toContain('1,300');
    expect(await r.frame().locator('.v-stat .n').allInnerTexts()).toEqual(['₹12,34,567', '2']);
    expect(await r.frame().locator('.v-chart svg rect').count()).toBe(2);
    expect(await r.page.locator('[data-vijaya-footer]').innerText()).toMatch(/^As of \d\d:\d\d · .*get_stock_value.* · \d+ rows$/);
    expect(r.leaked).toEqual([]); await r.close();
  }, 40000);

  it('database text that looks like HTML is shown as text and nothing loads', async () => {
    const r = await runDoc(doc('good', 'stock-report'), 'OWNER');
    expect(await r.frame().locator('tbody tr').nth(1).innerText()).toContain('<img src=https://evil.test/db');
    expect(await r.frame().locator('img').count()).toBe(0); await r.page.waitForTimeout(500);
    expect(r.leaked).toEqual([]); await r.close();
  }, 40000);

  it('row button opens the form with $row values filled in; nothing is written', async () => {
    const r = await runDoc(doc('good', 'stock-report'), 'OWNER');
    await r.frame().getByRole('button', { name: 'Make PO' }).first().click(); await r.page.waitForTimeout(300);
    expect(r.forms).toEqual([{ tool: 'create_purchase_order', prefill: { lines: [{ materialId: 'm1', quantity: 37.5 }] } }]); await r.close();
  }, 40000);

  it('a diagram renders as SVG inside the sandbox with no network', async () => {
    const r = await runDoc(doc('good', 'receiving-sop'), 'STOREKEEPER');
    expect(await r.frame().locator('.v-diagram svg').count()).toBe(1);
    expect(await r.frame().locator('.v-diagram svg .node').count()).toBeGreaterThanOrEqual(5);
    expect(await r.frame().locator('.v-diagram').innerText()).toContain('Record the receipt');
    expect(r.serverCalls).toEqual([]); expect(r.leaked).toEqual([]); await r.close();
  }, 40000);

  it('a document without a diagram does not ship the 5 MB diagram library', async () => {
    const r = await runDoc(doc('good', 'stock-report'), 'OWNER');
    expect(await r.frame().evaluate(() => typeof (window as any).mermaid)).toBe('undefined'); await r.close();
  }, 40000);

  it('hostile diagram text that skipped the checker: nothing runs, nothing leaks', async () => {
    const r = await runDoc(doc('hostile', 'doc-mermaid-injection'), 'OWNER');
    expect(await r.frame().evaluate(() => document.documentElement.getAttribute('data-vdoc'))).toBe('error');   // the renderer re-validates
    expect(r.leaked).toEqual([]); await r.close();
  }, 40000);

  it('a diagram label that tries to be HTML stays text (strict mode)', async () => {
    const r = await runDoc('---\ntitle: d\n---\n```mermaid\nflowchart LR\n  A["<img src=x onerror=window.__pwn=1>"] --> B[ok]\n```\n', 'OWNER');
    expect(await r.frame().evaluate(() => (window as any).__pwn)).toBeUndefined();
    expect(await r.frame().locator('.v-diagram img').count()).toBe(0); expect(r.leaked).toEqual([]); await r.close();
  }, 40000);

  it('markdown HTML and links in a document are plain text: no element, no request', async () => {
    const r = await runDoc(doc('hostile', 'doc-html-links'), 'OWNER');
    expect(await r.frame().locator('a').count()).toBe(0); expect(await r.page.locator('iframe').count()).toBe(1);
    expect(await r.frame().evaluate(() => document.body.innerText)).toContain('<a href="https://evil.test">'); expect(r.leaked).toEqual([]); await r.close();
  }, 40000);

  it('a storekeeper document that reads an owner-only tool shows nothing from it (host allow-list)', async () => {
    const r = await runDoc(doc('hostile', 'doc-owner-tool'), 'STOREKEEPER');
    expect(r.serverCalls).toEqual([]); expect(await r.frame().evaluate(() => document.body.innerText)).not.toMatch(/12,34,567|1234567/); await r.close();
  }, 40000);

  it('a document cannot open an admin form even if the checker is skipped', async () => {
    const r = await runDoc(doc('hostile', 'doc-admin-form'), 'OWNER');
    await r.frame().getByRole('button', { name: 'Add user' }).first().click(); await r.page.waitForTimeout(300);
    expect(r.forms).toEqual([]); await r.close();
  }, 40000);
});
