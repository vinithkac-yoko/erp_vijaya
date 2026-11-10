/* Helpers inside the sandbox: vijaya.ui and vijaya.fmt. Everything is written with textContent / createElementNS —
   never innerHTML — so text from the database can't become markup. Money, quantities and dates are formatted here, so
   artifact code never formats (or computes) business numbers itself. */
(function () {
  'use strict';
  var inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
  var num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var FORBIDDEN = /^(id|code|passwordHash|.*Id)$/;
  var fmt = {
    inr: function (n) { return n == null ? '—' : '₹' + inr.format(n); },
    num: function (n) { return n == null ? '—' : num.format(n); },
    pct: function (n) { return n == null ? '—' : (n > 0 ? '+' : '') + num.format(n) + '%'; },
    qty: function (n, unit) { return n == null ? '—' : num.format(n) + (unit ? ' ' + unit : ''); },
    date: function (s) { if (!s) return '—'; var d = new Date(s); return isNaN(d) ? String(s) : d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); },
  };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function root() { return document.getElementById('app') || document.body; }
  function add(node, into) { (into || root()).appendChild(node); return node; }
  function noId(f) { if (f != null && FORBIDDEN.test(String(f))) throw new Error('"' + f + '" is internal and cannot be shown'); }
  function cell(row, col) {
    noId(col.unitField);
    if (FORBIDDEN.test(col.field)) throw new Error('"' + col.field + '" is internal and cannot be shown');
    var v = row[col.field], f = col.format, td = el('td');
    if (f === 'qty') { td.className = 'num'; td.textContent = v == null ? '—' : num.format(v); var u = el('span', 'unit', ' ' + (row[col.unitField] || '')); if (col.unitField) td.appendChild(u); }
    else if (f === 'inr') { td.className = 'num'; td.textContent = fmt.inr(v); }
    else if (f === 'number') { td.className = 'num'; td.textContent = fmt.num(v); }
    else if (f === 'percent') { td.className = 'num'; td.textContent = fmt.pct(v); }
    else if (f === 'date') td.textContent = fmt.date(v);
    else td.textContent = v == null ? '—' : String(v);
    return td;
  }
  var ui = {
    heading: function (t, level) { return add(el(level === 2 ? 'h2' : 'h1', null, t)); },
    text: function (t) { return add(el('p', 'v-text', t)); },
    callout: function (tone, t) { return add(el('div', 'v-callout ' + (tone || ''), t)); },
    stats: function (items) {
      var g = add(el('div', 'v-stats'));
      items.forEach(function (it) {
        var s = el('div', 'v-stat'); s.appendChild(el('div', 'l', it.label));
        var v = it.format === 'inr' ? fmt.inr(it.value) : it.format === 'qty' ? fmt.qty(it.value, it.unit) : fmt.num(it.value);
        s.appendChild(el('div', 'n', v)); g.appendChild(s);
      });
      return g;
    },
    button: function (label, onClick) { var b = add(el('button', 'v-btn', label)); b.type = 'button'; b.addEventListener('click', onClick); return b; },
    table: function (o) {
      var wrap = add(el('div', 'v-tablewrap'));
      if (!o.rows || !o.rows.length) { wrap.appendChild(el('div', 'v-empty', o.empty || 'Nothing to show.')); return wrap; }
      var t = el('table', 'v-table'), thead = el('thead'), hr = el('tr');
      o.columns.forEach(function (c) { var th = el('th', null, c.label); if (['qty','inr','number','percent'].indexOf(c.format) >= 0) th.style.textAlign = 'right'; hr.appendChild(th); });
      var buttons = o.rowButtons || [];
      if (buttons.length) hr.appendChild(el('th', null, ''));
      thead.appendChild(hr); t.appendChild(thead);
      var tb = el('tbody');
      o.rows.forEach(function (row) {
        var tr = el('tr');
        o.columns.forEach(function (c) { tr.appendChild(cell(row, c)); });
        if (buttons.length) {
          var td = el('td');
          buttons.forEach(function (b) { var btn = el('button', 'v-btn small', b.label); btn.type = 'button'; btn.addEventListener('click', function () { b.onClick(row); }); td.appendChild(btn); });
          tr.appendChild(td);
        }
        tb.appendChild(tr);
      });
      t.appendChild(tb); wrap.appendChild(t); return wrap;
    },
    chart: function (o) {
      noId(o.x); noId(o.y); noId(o.series);
      var box = add(el('div', 'v-chart')); box.appendChild(el('div', 't', o.title));
      var rows = o.rows || [];
      if (!rows.length) { box.appendChild(el('div', 'v-empty', o.empty || 'Nothing to show.')); return box; }
      var NS = 'http://www.w3.org/2000/svg', W = 640, H = 260, L = 88, B = 30, T = 10, R = 10;
      var svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', o.title);
      var series = {}; rows.forEach(function (r) { var k = o.series ? String(r[o.series]) : 'all'; (series[k] = series[k] || []).push(r); });
      var xs = []; rows.forEach(function (r) { if (xs.indexOf(r[o.x]) < 0) xs.push(r[o.x]); });
      var max = Math.max.apply(null, rows.map(function (r) { return Number(r[o.y]) || 0; })) || 1;
      var colors = ['var(--copper)', 'var(--confirm)', 'var(--attention)', 'var(--ink-soft)', 'var(--alert)'];
      function X(i) { return L + (xs.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (xs.length - 1)); }
      function Y(v) { return T + (H - T - B) * (1 - v / max); }
      function node(tag, attrs, text) { var n = document.createElementNS(NS, tag); Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); }); if (text != null) n.textContent = text; svg.appendChild(n); return n; }
      [0, .5, 1].forEach(function (f) { var y = Y(max * f); node('line', { x1: L, x2: W - R, y1: y, y2: y, stroke: 'var(--line)' }); node('text', { x: L - 6, y: y + 4, 'text-anchor': 'end' }, (o.format === 'inr' ? fmt.inr(max * f) : fmt.num(max * f))); });
      xs.forEach(function (x, i) { if (xs.length <= 8 || i % Math.ceil(xs.length / 8) === 0) node('text', { x: X(i), y: H - 10, 'text-anchor': 'middle' }, o.xFormat === 'date' ? fmt.date(x) : String(x)); });
      var names = Object.keys(series);
      names.forEach(function (name, si) {
        var c = colors[si % colors.length], pts = series[name];
        if (o.type === 'bar') {
          var bw = Math.max(4, (W - L - R) / xs.length / (names.length + 1));
          pts.forEach(function (r) { var i = xs.indexOf(r[o.x]); var v = Number(r[o.y]) || 0; node('rect', { x: X(i) - bw * names.length / 2 + si * bw, y: Y(v), width: bw, height: Math.max(0, H - B - Y(v)), fill: c }); });
        } else {
          var d = pts.map(function (r, k) { return (k ? 'L' : 'M') + X(xs.indexOf(r[o.x])) + ' ' + Y(Number(r[o.y]) || 0); }).join(' ');
          node('path', { d: d, fill: 'none', stroke: c, 'stroke-width': 2 });
          pts.forEach(function (r) { node('circle', { cx: X(xs.indexOf(r[o.x])), cy: Y(Number(r[o.y]) || 0), r: 3, fill: c }); });
        }
      });
      box.appendChild(svg);
      if (o.series) { var lg = el('div', 'v-legend'); names.forEach(function (n, i) { lg.appendChild(el('span', null, '● ' + n)); lg.lastChild.style.color = colors[i % colors.length]; }); box.appendChild(lg); }
      return box;
    },
  };
  Object.defineProperty(window.vijaya, 'ui', { value: Object.freeze(ui) });
  Object.defineProperty(window.vijaya, 'fmt', { value: Object.freeze(fmt) });
})();
