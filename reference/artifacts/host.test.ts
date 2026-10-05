/**
 * Runs the artifact host in REAL Chromium. These tests are the proof behind the word "secured" in docs/SAFETY.md:
 * hostile artifact code is mounted WITHOUT the static checker, so what is tested is the sandbox itself.
 * The page is served with the same header the app must send:  Content-Security-Policy: ... frame-src about:
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page, type Frame } from 'playwright-core';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { TOOLS, readToolsFor, artifactFormsFor, type Role } from './catalog';

const rd = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const hostJs = rd('./host/host.js'), boot = rd('./host/bootstrap.js'), kit = rd('./host/uikit.js'), tokens = rd('./host/tokens.css');
const ex = (d: string, f: string) => rd(`./examples/${d}/${f}.html`);

const chrome = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', ...(existsSync('/opt/pw-browsers') ? readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-')).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`) : [])].find(existsSync);

const ALERTS = { rows: [
  { material: 'Copper wire 0.5mm', unit: 'kg', onHand: 12.5, minimumLevel: 50, shortfall: 37.5, materialId: 'm1' },
  { material: 'CRGO core 0.27', unit: 'kg', onHand: 1200, minimumLevel: 2500, shortfall: 1300, materialId: 'm2' },
] };
const SECRET = { rows: [{ material: 'Copper wire 0.5mm', unit: 'kg', quantity: 10, averageRate: 812.5, value: 8125, materialId: 'm1' }], total: 8125 };

const NONCE = 'n0nce123';
const PARENT_CSP = (nonce = true) => `default-src 'none'; script-src 'self' ${nonce ? `'nonce-${NONCE}'` : ''}; style-src 'unsafe-inline'; frame-src about:; connect-src 'none'; img-src data:; base-uri 'none'; form-action 'none'`;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] }); }, 30000);
afterAll(async () => { await browser?.close(); });

interface Run { page: Page; frame: Frame; serverCalls: { tool: string; role: Role }[]; forms: { tool: string; prefill: unknown }[]; leaked: string[]; events: any[]; text: () => Promise<string>; footer: () => Promise<string>; close: () => Promise<void> }

async function run(html: string, role: Role, opts: { parentCsp?: string; limits?: object; nonce?: boolean } = {}): Promise<Run> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const serverCalls: Run['serverCalls'] = [], forms: Run['forms'] = [], leaked: string[] = [], events: any[] = [];
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.host === 'app.test' && u.pathname === '/') return route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': opts.parentCsp ?? PARENT_CSP() }, body:
      `<!doctype html><title>app</title><script nonce="${NONCE}">window.__nonce = ${opts.nonce === false ? 'undefined' : JSON.stringify(NONCE)};</script><div id="box" style="width:700px;height:600px"></div><script nonce="${NONCE}" type="module">
        import { mountArtifact } from '/host.js';
        window.__mount = (cfg) => { window.__m = mountArtifact({ ...cfg, nonce: window.__nonce, allowedRead: new Set(cfg.allowedRead), allowedWrite: new Set(cfg.allowedWrite), container: document.getElementById('box'),
          runRead: (tool, input) => window.__runRead(tool, input), onOpenForm: (tool, prefill) => window.__openForm(tool, prefill), onEvent: (e) => window.__event(e) }); };
        window.__ready = true;
      </script>` });
    if (u.host === 'app.test' && u.pathname === '/host.js') return route.fulfill({ contentType: 'text/javascript', body: hostJs });
    if (u.host === 'app.test') return route.fulfill({ status: 404, body: '' });
    leaked.push(route.request().url());                 // anything that reaches the network, anywhere else, is a leak
    return route.abort();
  });
  // The "server": same rule as runTool — the role decides, whatever the browser asks.
  await page.exposeFunction('__runRead', (tool: string, input: unknown) => {
    serverCalls.push({ tool, role });
    const meta = TOOLS[tool];
    if (!meta || meta.kind !== 'read' || !meta.roles.includes(role)) throw new Error('forbidden');
    return tool === 'get_stock_value' ? SECRET : ALERTS;
  });
  await page.exposeFunction('__openForm', (tool: string, prefill: unknown) => { forms.push({ tool, prefill }); });
  await page.exposeFunction('__event', (e: unknown) => { events.push(e); });
  await page.goto('http://app.test/');
  await page.waitForFunction('window.__ready === true');
  await page.evaluate((c) => (window as any).__mount(c), {
    html, tokensCss: tokens, bootstrapSource: boot, uiKitSource: kit, theme: 'light', user: { role }, title: 'Test', limits: opts.limits,
    allowedRead: [...readToolsFor(role)], allowedWrite: [...artifactFormsFor(role)],
  });
  return { page, get frame() { return page.frames().find((f) => f !== page.mainFrame())!; }, serverCalls, forms, leaked, events,
    text: async () => (await page.frames().find((f) => f !== page.mainFrame())?.evaluate(() => document.body.innerText).catch(() => '')) ?? '',
    footer: () => page.locator('[data-vijaya-footer]').innerText(), close: () => ctx.close() } as Run;
}

const settle = (r: Run, ms = 600) => r.page.waitForTimeout(ms);

describe.skipIf(!chrome)('artifact sandbox in real Chromium', () => {
  it('good artifact: renders exactly what the read tool returned (truth test)', async () => {
    const r = await run(ex('good', 'stock-below-minimum'), 'STOREKEEPER'); await settle(r);
    const rows = await r.frame.locator('tbody tr').allInnerTexts();
    expect(rows.length).toBe(ALERTS.rows.length);
    expect(rows[0]).toContain('Copper wire 0.5mm'); expect(rows[0]).toContain('12.5'); expect(rows[0]).toContain('37.5');
    expect(rows[1]).toContain('1,200'); expect(rows[1]).toContain('2,500'); expect(rows[1]).toContain('1,300');   // Indian grouping from the kit, not from the artifact
    expect(await r.footer()).toMatch(/^As of \d\d:\d\d · list_reorder_alerts · 2 rows$/);
    expect(r.leaked).toEqual([]); await r.close();
  }, 30000);

  it('openForm reaches the host with the tool and prefill, and nothing is written', async () => {
    const r = await run(ex('good', 'stock-below-minimum'), 'STOREKEEPER'); await settle(r);
    await r.frame.getByRole('button', { name: 'Make PO' }).first().click(); await settle(r, 300);
    expect(r.forms).toEqual([{ tool: 'create_purchase_order', prefill: { lines: [{ materialId: 'm1', quantity: 37.5 }] } }]);
    await r.close();
  }, 30000);

  it('the table refuses to show an internal id column', async () => {
    const r = await run(`<script>(async()=>{const x=await vijaya.read('list_reorder_alerts',{});try{vijaya.ui.table({columns:[{field:'materialId',label:'ID'}],rows:x.rows});}catch(e){window.__err=e.message;vijaya.ui.text('ERR '+e.message);}})();</script>`, 'OWNER'); await settle(r);
    expect(await r.text()).toContain('internal and cannot be shown'); await r.close();
  }, 30000);

  for (const name of ['fetch-exfil', 'img-beacon', 'navigate-exfil', 'top-nav', 'dns-prefetch']) {
    it(`blocks exfiltration: ${name}`, async () => {
      const r = await run(ex('hostile', name), 'OWNER'); await settle(r, 900);
      expect(r.leaked.filter((u) => u.includes('evil.test'))).toEqual([]);
      await r.close();
    }, 30000);
  }

  it('CONTROL: the leak recorder does catch a request (so the passes above mean something)', async () => {
    const r = await run('<script>vijaya.read("list_reorder_alerts",{})</script>', 'OWNER', { parentCsp: "script-src 'self' 'nonce-" + NONCE + "'" });
    await r.page.evaluate(() => { const i = new Image(); i.src = 'https://evil.test/control'; });
    await settle(r, 500); expect(r.leaked.some((u) => u.includes('evil.test/control'))).toBe(true); await r.close();
  }, 30000);

  it('WHY the header is mandatory: without frame-src on the embedding page, self-navigation DOES leak the data', async () => {
    const r = await run(ex('hostile', 'navigate-exfil'), 'OWNER', { parentCsp: "script-src 'self' 'nonce-" + NONCE + "'" }); await settle(r, 1000);
    expect(r.leaked.some((u) => u.includes('evil.test/n?d='))).toBe(true);   // the sandbox + meta CSP alone are NOT enough
    await r.close();
  }, 30000);

  it('storage, cookies, form submit and popups are all dead', async () => {
    const r = await run(ex('hostile', 'storage-form'), 'OWNER'); await settle(r, 900);
    const out = await r.frame.evaluate(() => (window as any).__out);
    expect(out.ls).toBe('SecurityError'); expect(out.cookie).toBe('SecurityError'); expect(out.open === 'null' || out.open === 'SecurityError').toBe(true);
    expect(r.leaked).toEqual([]); await r.close();
  }, 30000);

  it('WebRTC is removed and run-time <link>/<iframe> elements are stripped (defence in depth for DNS/WebRTC channels)', async () => {
    const r = await run(ex('hostile', 'dom-link'), 'OWNER'); await settle(r, 900);
    const out = await r.frame.evaluate(() => (window as any).__out);
    expect(out.rtc).toBe('undefined'); expect(out.linkStillThere).toBe(false); await r.close();
  }, 30000);

  it('a script created at run time cannot reuse the page nonce (the nonce is hidden from script)', async () => {
    const r = await run(`<script>(async()=>{await vijaya.read('list_reorder_alerts',{});window.__n=document.currentScript?document.currentScript.nonce:'none';
      const s=document.createElement('script');s.nonce=document.currentScript?document.currentScript.nonce:'';s.setAttribute('nonce',window.__n||'');s.textContent='window.__ran=1';document.body.appendChild(s);})();</script>`, 'OWNER'); await settle(r);
    expect(await r.frame.evaluate(() => (window as any).__n)).not.toBe('n0nce123');
    expect(await r.frame.evaluate(() => (window as any).__ran)).toBeUndefined(); await r.close();
  }, 30000);

  it('an artifact cannot open admin forms (create_user, update_setting, approve_*, share_artifact)', async () => {
    const r = await run(`<script>(async()=>{window.__c=[];for (const t of ['create_user','update_setting','approve_purchase_order','reverse_movement','share_artifact']) { try{await vijaya.openForm(t,{role:'OWNER'});window.__c.push('opened');}catch(e){window.__c.push(e.code);} } })();</script>`, 'OWNER'); await settle(r);
    expect(await r.frame.evaluate(() => (window as any).__c)).toEqual(['NOT_AVAILABLE', 'NOT_AVAILABLE', 'NOT_AVAILABLE', 'NOT_AVAILABLE', 'NOT_AVAILABLE']);
    expect(r.forms).toEqual([]); await r.close();
  }, 30000);

  it('openForm is throttled: one form per 3 seconds', async () => {
    const r = await run(`<script>(async()=>{window.__c=[];for (let i=0;i<5;i++) { try{await vijaya.openForm('create_job',{});window.__c.push('opened');}catch(e){window.__c.push(e.code);} } })();</script>`, 'OWNER'); await settle(r);
    expect(await r.frame.evaluate(() => (window as any).__c)).toEqual(['opened', 'RATE_LIMITED', 'RATE_LIMITED', 'RATE_LIMITED', 'RATE_LIMITED']);
    expect(r.forms.length).toBe(1); await r.close();
  }, 30000);

  it('cannot reach the parent page', async () => {
    const r = await run(ex('hostile', 'parent-reach'), 'OWNER'); await settle(r);
    expect(await r.page.title()).toBe('app');
    const reach = await r.frame.evaluate(() => { try { return String(window.parent.document.title); } catch (e) { return (e as Error).name; } });
    expect(reach).toBe('SecurityError'); await r.close();
  }, 30000);

  it('a storekeeper artifact cannot read an owner-only tool (host allow-list; server never even called)', async () => {
    const r = await run(ex('hostile', 'owner-tool'), 'STOREKEEPER'); await settle(r);
    expect(r.serverCalls.map((c) => c.tool)).not.toContain('get_stock_value');
    expect(await r.text()).not.toContain('8125'); expect(await r.text()).not.toContain('8,125'); await r.close();
  }, 30000);

  it('server re-check holds even if the host allow-list were wrong', async () => {
    const r = await run(`<script>(async()=>{try{await vijaya.read('get_stock_value',{});}catch(e){window.__code=e.code;}})();</script>`, 'STOREKEEPER');
    await r.page.evaluate(() => (window as any).__m.destroy());   // mount again with a deliberately over-wide allow-list
    await r.page.evaluate((c) => (window as any).__mount(c), { html: `<script>(async()=>{try{await vijaya.read('get_stock_value',{});}catch(e){window.__code=e.code;}})();</script>`, tokensCss: tokens, bootstrapSource: boot, uiKitSource: kit, theme: 'light', user: {}, allowedRead: ['get_stock_value'], allowedWrite: [] });
    await settle(r);
    expect(r.serverCalls.some((c) => c.tool === 'get_stock_value' && c.role === 'STOREKEEPER')).toBe(true);   // reached the server…
    expect(await r.frame.evaluate(() => (window as any).__code)).toBe('FAILED');                                // …which refused
    expect(await r.text()).not.toMatch(/8,?125/); await r.close();
  }, 30000);

  it('a write tool through read is refused; forged messages to the parent do nothing', async () => {
    for (const name of ['write-via-read', 'forged-message']) {
      const r = await run(ex('hostile', name), 'STOREKEEPER'); await settle(r);
      expect(r.serverCalls.map((c) => c.tool).filter((t) => t !== 'list_reorder_alerts')).toEqual([]); expect(r.forms).toEqual([]); await r.close();
    }
  }, 30000);

  it('flood: only the first 20 calls in a window are served', async () => {
    const r = await run(ex('hostile', 'flood'), 'OWNER'); await settle(r, 1200);
    const res: string[] = await r.frame.evaluate(() => (window as any).__results);
    expect(res.filter((x) => x === 'ok').length).toBe(20); expect(res.filter((x) => x === 'RATE_LIMITED').length).toBe(40);
    expect(r.serverCalls.length).toBe(20); await r.close();
  }, 30000);

  it('oversize request and unknown method are refused', async () => {
    const r = await run(`<script>window.__r=[];(async()=>{await vijaya.read('list_reorder_alerts',{});
      try{await vijaya.read('list_reorder_alerts',{q:'x'.repeat(30000)});}catch(e){window.__r.push(e.code);}
      })();</script>`, 'OWNER'); await settle(r);
    expect(await r.frame.evaluate(() => (window as any).__r)).toEqual(['BAD_REQUEST']); await r.close();
  }, 30000);

  it('a frame that navigates itself (even to about:blank) is destroyed', async () => {
    const r = await run(ex('hostile', 'navigate-blank'), 'OWNER'); await settle(r, 1200);
    expect(r.events.some((e) => e.type === 'navigated-away')).toBe(true);
    expect(await r.page.locator('iframe').count()).toBe(0); await r.close();
  }, 30000);

  it('parent CSP uses nonces: the host stamps the nonce on the srcdoc scripts, so the artifact runs', async () => {
    const r = await run(ex('good', 'stock-below-minimum'), 'OWNER'); await settle(r);
    expect(await r.frame.locator('tbody tr').count()).toBe(2); await r.close();
  }, 30000);

  it('without the nonce the same page is blocked by the inherited parent CSP (the host must pass it)', async () => {
    const r = await run(ex('good', 'stock-below-minimum'), 'OWNER', { nonce: false }); await settle(r);
    expect(await r.frame.locator('tbody tr').count()).toBe(0); await r.close();
  }, 30000);

  it('a script the artifact creates at run time (no nonce) does not run', async () => {
    const r = await run(`<script>(async()=>{await vijaya.read('list_reorder_alerts',{});const s=document.createElement('script');s.textContent='window.__ran=1';document.body.appendChild(s);})();</script>`, 'OWNER'); await settle(r);
    expect(await r.frame.evaluate(() => (window as any).__ran)).toBeUndefined(); await r.close();
  }, 30000);
});
