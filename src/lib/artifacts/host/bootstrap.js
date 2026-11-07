/* Runs FIRST inside the sandboxed artifact frame. Defines window.vijaya (read, openForm, ready, theme, user).
   The only way out of the frame is the MessageChannel port the host hands over once. */
(function () {
  'use strict';
  var seq = 0, pending = new Map(), port = null;
  var ready = new Promise(function (resolve) {
    function onInit(e) {
      if (e.source !== window.parent || !e.data || e.data.type !== 'vijaya-init' || !e.ports || !e.ports[0]) return;
      window.removeEventListener('message', onInit);
      port = e.ports[0];
      port.onmessage = function (ev) {
        var m = ev.data, p = m && pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.result);
        else { var err = new Error((m.error && m.error.message) || 'Not available'); err.code = m.error && m.error.code; p.reject(err); }
      };
      document.documentElement.setAttribute('data-theme', e.data.theme === 'dark' ? 'dark' : 'light');
      resolve({ user: e.data.user, theme: e.data.theme });
    }
    window.addEventListener('message', onInit);
  });
  function call(method, params) {
    return ready.then(function () {
      return new Promise(function (resolve, reject) {
        var id = ++seq; pending.set(id, { resolve: resolve, reject: reject });
        port.postMessage({ id: id, method: method, params: params });
      });
    });
  }
  var api = {
    read: function (tool, input) { return call('read', { tool: tool, input: input || {} }); },
    openForm: function (tool, prefill) { return call('openForm', { tool: tool, prefill: prefill || {} }); },
    ready: ready,
  };
  // Defence in depth (the sandbox + CSP are the real wall): no WebRTC, and no resource-hint / frame / form elements,
  // which CSP does not govern (DNS prefetch). See docs/SAFETY.md "residual risks".
  ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'].forEach(function (k) { try { Object.defineProperty(window, k, { value: undefined, configurable: false }); } catch (e) {} });
  // Hide the CSP nonce from script: an artifact that could read document.currentScript.nonce could stamp it on a script
  // it creates at run time and run code the inherited page CSP was meant to block (found by the kit's own review).
  [HTMLElement.prototype, SVGElement.prototype].forEach(function (proto) {
    try { Object.defineProperty(proto, 'nonce', { get: function () { return ''; }, set: function () {}, configurable: false }); } catch (e) {}
  });
  try {
    new MutationObserver(function (list) {
      list.forEach(function (m) { m.addedNodes.forEach(function (n) {
        if (n.nodeType === 1 && /^(LINK|META|BASE|IFRAME|OBJECT|EMBED|FORM)$/.test(n.tagName) && !(n.tagName === 'META' && /Content-Security-Policy|x-dns-prefetch-control/i.test(n.getAttribute('http-equiv') || ''))) n.remove();
      }); });
    }).observe(document, { childList: true, subtree: true });
  } catch (e) {}
  Object.defineProperty(window, 'vijaya', { value: api, writable: false, configurable: false });
})();
