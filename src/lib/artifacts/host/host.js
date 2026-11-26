/* Artifact host — runs in OUR page (not in the sandbox). ES module.
 *
 * Threat model: the artifact's code is written by a model and may have been steered by text in the database
 * (prompt injection). The sandbox must hold even if the code is hostile. See docs/SAFETY.md §4.
 *
 *  1. <iframe sandbox="allow-scripts"> — no allow-same-origin / forms / popups / top-navigation / downloads.
 *  2. srcdoc + meta CSP default-src 'none' (no network, no images from outside, no frames, no workers).
 *  3. The ONLY way out is one MessageChannel port with a method allow-list: read | openForm.
 *     Identity is the port itself — never event.origin (it is "null" in a sandbox).
 *  4. The page that embeds this must send  Content-Security-Policy: frame-src about:  so the frame cannot
 *     navigate itself to a URL (a navigation to https://evil/?data would leak without any fetch).
 *  5. Every call is checked again here (role allow-lists, rate, sizes) and AGAIN on the server (runTool).
 */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; " +
  "font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; " +
  "form-action 'none'; base-uri 'none'";

export const DEFAULT_LIMITS = { callsPerWindow: 20, windowMs: 10_000, maxRequestBytes: 20_000, maxResultBytes: 2_000_000 };

export const needsMermaid = (source) => /^```mermaid\s*$/m.test(String(source || ''));

/**
 * kind "page": `html` is a body fragment with the artifact's own script.
 * kind "document": `source` is VDoc text. No model-written script exists; WE inject vdoc.js + docrender.js (and the
 * mermaid bundle only when the document has a diagram). The source goes in as inert JSON, never as markup.
 */
export function buildSandboxDoc({ kind, html, source, tokensCss, bootstrapSource, uiKitSource, vdocSource, docRenderSource, mermaidSource, theme, nonce }) {
  // A srcdoc frame INHERITS the embedding page's CSP. If the page uses nonces (it should), inline scripts here need
  // that nonce too. We stamp it on every <script> in the document. Scripts the artifact creates at run time have no
  // nonce and stay blocked; the artifact's own inline scripts are allowed because they are the artifact.
  var n = nonce ? ' nonce="' + String(nonce).replace(/[^A-Za-z0-9+/=_-]/g, '') + '"' : '';
  var stamp = function (h) { return n ? h.replace(/<script(?=[\s>])/gi, '<script' + n) : h; };
  var inline = function (js) { return '<script' + n + '>' + String(js).replace(/<\/script/gi, '<\\/script') + '<\/script>'; };
  var body;
  if (kind === 'document') {
    var json = JSON.stringify(String(source || '')).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    body = '<div id="app"></div><script type="application/json" id="vdoc-src">' + json + '<\/script>' +
      (needsMermaid(source) && mermaidSource ? inline(mermaidSource) : '') + inline(vdocSource) + inline(docRenderSource);
  } else body = '<div id="app"></div>' + stamp(html);
  return '<!doctype html><html data-theme="' + (theme === 'dark' ? 'dark' : 'light') + '"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + SANDBOX_CSP + '"><meta http-equiv="x-dns-prefetch-control" content="off">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><style>' + tokensCss + '</style>' +
    inline(bootstrapSource) + inline(uiKitSource) + '</head><body>' + body + '</body></html>';
}

const err = (code, message) => ({ code, message });
const size = (v) => { try { return JSON.stringify(v).length; } catch { return Infinity; } };
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function mountArtifact(cfg) {
  const limits = { ...DEFAULT_LIMITS, ...(cfg.limits || {}) };
  const reads = [];                       // what this artifact actually read (drives the footer)
  const stamps = [];
  let destroyed = false;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('title', cfg.title || 'Artifact');
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block';
  iframe.srcdoc = buildSandboxDoc({ kind: cfg.kind, source: cfg.source, vdocSource: cfg.vdocSource, docRenderSource: cfg.docRenderSource, mermaidSource: cfg.mermaidSource, html: cfg.html, tokensCss: cfg.tokensCss, bootstrapSource: cfg.bootstrapSource, uiKitSource: cfg.uiKitSource, theme: cfg.theme, nonce: cfg.nonce });

  const footer = document.createElement('div');           // drawn by the host, so an artifact can't hide or fake it
  footer.setAttribute('data-vijaya-footer', '');
  footer.style.cssText = 'font:13px system-ui;color:#66727F;padding:6px 12px;border-top:1px solid #D6CDB8';
  const renderFooter = () => {
    const t = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
    const tools = [...new Set(reads.map((r) => r.tool))];
    footer.textContent = reads.length ? 'As of ' + t + ' · ' + tools.join(', ') + ' · ' + reads.reduce((n, r) => n + r.rows, 0) + ' rows' : 'No data read yet';
  };
  renderFooter();
  cfg.container.append(iframe, footer);

  const channel = new MessageChannel();
  const port = channel.port1;
  let loads = 0;
  iframe.addEventListener('load', () => {
    loads++;
    if (loads === 1) iframe.contentWindow.postMessage({ type: 'vijaya-init', user: cfg.user, theme: cfg.theme }, '*', [channel.port2]);
    else { cfg.onEvent?.({ type: 'navigated-away' }); destroy(); }       // a second load means the frame navigated: kill it
  });

  const calls = [];
  let overLimit = 0, formsOpened = 0, lastForm = 0;
  const rateOk = () => {
    const now = Date.now();
    while (calls.length && now - calls[0] > limits.windowMs) calls.shift();
    if (calls.length >= limits.callsPerWindow) return false;
    calls.push(now);
    return true;
  };

  port.onmessage = async (e) => {
    if (destroyed) return;
    const m = e.data;
    // Count EVERY message first, before any parsing or size check, so junk can't be used to burn the phone's CPU.
    if (!rateOk()) {
      if (++overLimit > 200) { cfg.onEvent?.({ type: 'flood-killed' }); destroy(); return; }
      if (isPlain(m) && typeof m.id === 'number' && !destroyed) port.postMessage({ id: m.id, ok: false, error: err('RATE_LIMITED', 'Too many requests. Slow down.') });
      return;
    }
    if (!isPlain(m) || typeof m.id !== 'number') { cfg.onEvent?.({ type: 'junk' }); return; }
    const reply = (ok, payload) => { if (!destroyed) port.postMessage(ok ? { id: m.id, ok: true, result: payload } : { id: m.id, ok: false, error: payload }); };
    const block = (code, message, method) => { cfg.onEvent?.({ type: 'blocked', code, method: m.method }); reply(false, err(code, message)); };

    if (m.method !== 'read' && m.method !== 'openForm') return block('BAD_METHOD', 'Not available.');
    if (!isPlain(m.params) || size(m.params) > limits.maxRequestBytes) return block('BAD_REQUEST', 'Request too large.');
    const { tool } = m.params;
    if (typeof tool !== 'string') return block('BAD_REQUEST', 'Not available.');

    if (m.method === 'read') {
      if (!cfg.allowedRead.has(tool)) return block('NOT_AVAILABLE', "This isn't available to you.");
      const input = isPlain(m.params.input) ? m.params.input : {};
      try {
        const result = await cfg.runRead(tool, input);               // server round trip: runTool re-checks the role
        if (size(result) > limits.maxResultBytes) return block('TOO_BIG', 'That is too much data. Narrow it down.');
        const rows = Array.isArray(result?.rows) ? result.rows.length : 1;
        reads.push({ tool, input, rows, at: Date.now() });
        renderFooter();
        reply(true, result);
      } catch (ex) { block('FAILED', "Couldn't load that. Try again."); }
    } else {
      if (!cfg.allowedWrite.has(tool)) return block('NOT_AVAILABLE', "This isn't available to you.");
      // No proof of a user click is possible from outside the frame, so cap it: one form per 3 s, 10 per artifact.
      const nowT = Date.now();
      if (nowT - lastForm < 3000 || formsOpened >= 10) return block('RATE_LIMITED', 'Too many forms. Slow down.');
      lastForm = nowT; formsOpened++;
      const prefill = isPlain(m.params.prefill) ? m.params.prefill : {};
      try { await cfg.onOpenForm(tool, prefill); reply(true, { opened: true }); }   // opens the tool's form; never writes
      catch (ex) { block('FAILED', "Couldn't open that form."); }
    }
  };

  function destroy() { if (destroyed) return; destroyed = true; try { port.close(); } catch {} iframe.remove(); footer.remove(); }
  return { iframe, footer, reads, destroy };
}
