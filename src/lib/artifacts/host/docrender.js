/* Runs INSIDE the sandbox for kind "document". Reads the document source (JSON in #vdoc-src), runs the declared reads
   through vijaya.read (same port, same checks as a page artifact), and draws the blocks. No model-written script ever
   runs: the model wrote text, this file is ours. All text goes in with textContent. The only innerHTML is the SVG that
   mermaid returns, which is rendered with securityLevel "strict" (labels escaped, no click handlers) — and the checker
   already rejected script/click/href/init in diagram text. */
(function () {
  'use strict';
  var V = window.VDoc, ui = window.vijaya.ui;
  var app = document.getElementById('app');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function put(node) { app.appendChild(node); return node; }
  var ALIAS = { num: 'number', pct: 'percent' };
  function inlines(parent, list, data) {
    list.forEach(function (n) {
      if (n.t === 'text') parent.appendChild(document.createTextNode(n.v));
      else if (n.t === 'bind') { var s = el('span', 'v-bound', V.formatValue(V.getPath(data, n.ref), n.fmt)); parent.appendChild(s); }
      else if (n.t === 'b') parent.appendChild(inlines(el('strong'), n.kids, data));
      else if (n.t === 'i') parent.appendChild(inlines(el('em'), n.kids, data));
      else parent.appendChild(el('code', null, n.v));
    });
    return parent;
  }
  function fail(msg) { put(el('div', 'v-callout alert', msg)); }
  var diagrams = [];

  function draw(model, data, failed) {
    app.textContent = '';
    if (model.title && !V.hasOwnH1(model)) put(el('h1', null, model.title));
    Object.keys(failed).forEach(function (n) { fail('Could not load the data for "' + n + '". Try again.'); });
    model.blocks.forEach(function (b) {
      if (b.type === 'h') put(inlines(el('h' + Math.min(3, b.level)), b.inlines, data));
      else if (b.type === 'p') put(inlines(el('p', 'v-text'), b.inlines, data));
      else if (b.type === 'quote') put(inlines(el('blockquote', 'v-quote'), b.inlines, data));
      else if (b.type === 'hr') put(el('hr'));
      else if (b.type === 'code') put(el('pre', 'v-code', b.text));
      else if (b.type === 'list') { var l = el(b.ordered ? 'ol' : 'ul', 'v-list'); b.items.forEach(function (it) { l.appendChild(inlines(el('li'), it, data)); }); put(l); }
      else if (b.type === 'table') {
        var w = el('div', 'v-tablewrap'), t = el('table', 'v-table'), th = el('thead'), hr = el('tr');
        b.head.forEach(function (h) { hr.appendChild(inlines(el('th'), h, data)); }); th.appendChild(hr); t.appendChild(th);
        var tb = el('tbody'); b.rows.forEach(function (r) { var tr = el('tr'); r.forEach(function (c) { tr.appendChild(inlines(el('td'), c, data)); }); tb.appendChild(tr); });
        t.appendChild(tb); w.appendChild(t); put(w);
      }
      else if (b.type === 'vtable') {
        var res = data[b.spec.from] || { rows: [] };
        var cols = b.spec.columns.map(function (c) { return { field: c.field, label: c.label || c.field, format: ALIAS[c.format] || c.format, unitField: c.unitField }; });
        var btns = (b.spec.rowButtons || []).map(function (rb) { return { label: rb.label, onClick: function (row) { window.vijaya.openForm(rb.tool, V.rowPrefill(rb.prefill || {}, row)).catch(function () {}); } }; });
        ui.table({ columns: cols, rows: res.rows, rowButtons: btns, empty: b.spec.empty });
      }
      else if (b.type === 'vchart') {
        var rs = data[b.spec.from] || { rows: [] };
        ui.chart({ title: b.spec.title || '', type: b.spec.type || 'bar', x: b.spec.x, y: b.spec.y, series: b.spec.series, format: b.spec.format, xFormat: b.spec.xFormat, rows: rs.rows, empty: b.spec.empty });
      }
      else if (b.type === 'vstats') {
        var g = put(el('div', 'v-stats'));
        b.spec.forEach(function (s) { var d = el('div', 'v-stat'); d.appendChild(el('div', 'l', s.label)); d.appendChild(el('div', 'n', V.formatValue(V.getPath(data, s.from + '.' + s.path), s.format))); g.appendChild(d); });
      }
      else if (b.type === 'mermaid') { var box = put(el('div', 'v-diagram')); box.setAttribute('role', 'img'); box.setAttribute('aria-label', 'Diagram'); diagrams.push({ box: box, text: V.substituteBindings(b.text, data) }); }
    });
  }

  function drawDiagrams() {
    if (!diagrams.length) return Promise.resolve();
    if (!window.mermaid) { diagrams.forEach(function (d) { d.box.appendChild(el('pre', 'v-code', d.text)); }); return Promise.resolve(); }
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', flowchart: { htmlLabels: false } });
    return diagrams.reduce(function (p, d, i) {
      return p.then(function () {
        return window.mermaid.render('vd' + i, d.text).then(function (r) { d.box.innerHTML = r.svg; })
          .catch(function () { d.box.textContent = ''; d.box.appendChild(el('div', 'v-callout alert', 'This diagram could not be drawn.')); });
      });
    }, Promise.resolve());
  }

  var raw = document.getElementById('vdoc-src');
  var model = V.parse(JSON.parse(raw.textContent));
  var issues = V.validate(model);
  if (issues.length) { fail('This document has a problem: ' + issues[0]); document.documentElement.setAttribute('data-vdoc', 'error'); return; }
  var names = Object.keys(model.reads), data = {}, failed = {};
  Promise.all(names.map(function (n) {
    return window.vijaya.read(model.reads[n].tool, model.reads[n].input).then(function (r) { data[n] = r; }, function () { failed[n] = 1; });
  })).then(function () { draw(model, data, failed); return drawDiagrams(); })
    .then(function () { document.documentElement.setAttribute('data-vdoc', 'done'); });
})();
