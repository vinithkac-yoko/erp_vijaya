/* VDoc — the document format for reports, memos, SOPs, write-ups and diagrams.
 *
 * A VDoc is Markdown plus a small header that names the read tools it uses. There is NO model-written JavaScript, so
 * a document cannot misbehave, and the SERVER can parse the same text to check it and to export it (PDF, Word, Excel,
 * Markdown) with real numbers. Numbers are never typed: they are bindings like {{value.total|inr}}.
 *
 *   ---
 *   title: Stock position
 *   reads:
 *     alerts: list_reorder_alerts {}
 *     value: get_stock_value {}
 *   ---
 *   # Stock position
 *   Total stock value is {{value.total|inr}}; {{alerts.count}} materials are below minimum.
 *
 *   ```vtable
 *   {"from":"alerts","columns":[{"field":"material","label":"Material"},{"field":"shortfall","label":"Short by","format":"qty","unitField":"unit"}]}
 *   ```
 *   ```vchart
 *   {"from":"value","type":"bar","x":"material","y":"value","format":"inr","title":"Value by material"}
 *   ```
 *   ```vstats
 *   [{"label":"Total value","from":"value","path":"total","format":"inr"}]
 *   ```
 *   ```mermaid
 *   flowchart LR
 *     A[Customer PO] --> B[Job] --> C{Short?}
 *   ```
 *
 * Plain script file (.cjs so Node loads it as CommonJS; the sandbox gets its text): works in the sandbox (window.VDoc) and in Node (module.exports). */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.VDoc = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var inrF = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
  var numF = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });
  var fmt = {
    inr: function (n) { return n == null ? '—' : '₹' + inrF.format(n); },
    num: function (n) { return n == null ? '—' : numF.format(n); },
    pct: function (n) { return n == null ? '—' : (n > 0 ? '+' : '') + numF.format(n) + '%'; },
    qty: function (n, unit) { return n == null ? '—' : numF.format(n) + (unit ? ' ' + unit : ''); },
    date: function (s) { if (!s) return '—'; var d = new Date(s); return isNaN(d) ? String(s) : d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); },
  };
  var FORMATS = { inr: 1, num: 1, pct: 1, qty: 1, date: 1, text: 1, number: 1, percent: 1 };
  var FORBIDDEN_DISPLAY = /^(id|code|passwordHash|.*Id)$/;
  var BLOCK_LANGS = { vtable: 1, vchart: 1, vstats: 1, mermaid: 1 };

  function formatValue(v, f, unit) {
    switch (f) {
      case 'inr': return fmt.inr(v);
      case 'num': case 'number': return fmt.num(v);
      case 'pct': case 'percent': return fmt.pct(v);
      case 'qty': return fmt.qty(v, unit);
      case 'date': return fmt.date(v);
      default: return v == null ? '—' : String(v);
    }
  }

  // ---- header -------------------------------------------------------------------------------------------------
  function parseHeader(lines, errors) {
    var meta = { title: '', reads: {} };
    if (lines[0] !== '---') return { meta: meta, rest: 0 };
    var end = lines.indexOf('---', 1);
    if (end < 0) { errors.push('The header starting with --- is never closed.'); return { meta: meta, rest: lines.length }; }
    var inReads = false;
    for (var i = 1; i < end; i++) {
      var ln = lines[i]; if (!ln.trim()) continue;
      var t = /^title:\s*(.*)$/.exec(ln);
      if (t) { meta.title = t[1].trim(); inReads = false; continue; }
      if (/^reads:\s*$/.test(ln)) { inReads = true; continue; }
      var r = /^\s+([A-Za-z][A-Za-z0-9_]*):\s*([a-z][a-z_]*)\s*(\{.*\})?\s*$/.exec(ln);
      if (inReads && r) {
        var input = {};
        if (r[3]) { try { input = JSON.parse(r[3]); } catch (e) { errors.push('Bad input for read "' + r[1] + '": not valid JSON.'); } }
        if (meta.reads[r[1]]) errors.push('Read "' + r[1] + '" is declared twice.');
        meta.reads[r[1]] = { tool: r[2], input: input };
      } else errors.push('Cannot read header line: ' + ln.slice(0, 60));
    }
    return { meta: meta, rest: end + 1 };
  }

  // ---- inline text --------------------------------------------------------------------------------------------
  // returns [{t:'text'|'b'|'i'|'code'|'bind', ...}]
  function parseInline(s) {
    var out = [], re = /\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*(?:\|\s*([a-z]+))?\s*\}\}|\*\*([^*]+)\*\*|(?:\*([^*\n]+)\*|\b_([^_\n]+)_\b)|`([^`\n]+)`/g, last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
      if (m[1] !== undefined) out.push({ t: 'bind', ref: m[1], fmt: m[2] || 'text' });
      else if (m[3] !== undefined) out.push({ t: 'b', kids: parseInline(m[3]) });
      else if (m[4] !== undefined || m[5] !== undefined) out.push({ t: 'i', kids: parseInline(m[4] !== undefined ? m[4] : m[5]) });
      else out.push({ t: 'code', v: m[6] });
      last = re.lastIndex;
    }
    if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
    return out;
  }

  // ---- blocks -------------------------------------------------------------------------------------------------
  function splitRow(l) { return l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); }); }

  function parse(source) {
    var errors = [], lines = String(source).replace(/\r\n?/g, '\n').split('\n');
    var h = parseHeader(lines, errors), blocks = [], i = h.rest, para = [];
    function flush() { if (para.length) { blocks.push({ type: 'p', inlines: parseInline(para.join(' ')) }); para = []; } }
    while (i < lines.length) {
      var ln = lines[i];
      var fence = /^```\s*([A-Za-z]*)\s*$/.exec(ln);
      if (fence) {
        flush();
        var lang = fence[1], body = []; i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
        if (i >= lines.length) errors.push('A ``` block is never closed.'); else i++;
        var text = body.join('\n');
        if (lang === 'vtable' || lang === 'vchart' || lang === 'vstats') {
          try { blocks.push({ type: lang, spec: JSON.parse(text) }); } catch (e) { errors.push('The ' + lang + ' block is not valid JSON.'); }
        } else if (lang === 'mermaid') blocks.push({ type: 'mermaid', text: text });
        else blocks.push({ type: 'code', text: text });
        continue;
      }
      if (!ln.trim()) { flush(); i++; continue; }
      var hd = /^(#{1,3})\s+(.*)$/.exec(ln);
      if (hd) { flush(); blocks.push({ type: 'h', level: hd[1].length, inlines: parseInline(hd[2].trim()) }); i++; continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(ln)) { flush(); blocks.push({ type: 'hr' }); i++; continue; }
      if (/^>\s?/.test(ln)) { flush(); var q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, '')); blocks.push({ type: 'quote', inlines: parseInline(q.join(' ')) }); continue; }
      var li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(ln);
      if (li) {
        flush(); var ordered = /\d/.test(li[1]), items = [];
        while (i < lines.length && (li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i])) && /\d/.test(li[1]) === ordered) { items.push(parseInline(li[2])); i++; }
        blocks.push({ type: 'list', ordered: ordered, items: items }); continue;
      }
      if (/^\s*\|.*\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush(); var head = splitRow(ln), rows = []; i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]).map(parseInline));
        blocks.push({ type: 'table', head: head.map(parseInline), rows: rows }); continue;
      }
      para.push(ln.trim()); i++;
    }
    flush();
    return { title: h.meta.title, reads: h.meta.reads, blocks: blocks, errors: errors };
  }

  // ---- structure checks (role / tool checks live in artifact-check.ts) ------------------------------------------
  function flat(list) { var o = []; list.forEach(function (n) { if (n.kids) o = o.concat(flat(n.kids)); else o.push(n); }); return o; }
  function allInlines(model) {
    var out = [];
    model.blocks.forEach(function (b) {
      if (b.inlines) out = out.concat(b.inlines);
      if (b.items) b.items.forEach(function (it) { out = out.concat(it); });
      if (b.head) b.head.forEach(function (c) { out = out.concat(c); });
      if (b.rows) b.rows.forEach(function (r) { r.forEach(function (c) { out = out.concat(c); }); });
    });
    return flat(out);
  }
  function validate(model) {
    var issues = model.errors.slice(), names = model.reads;
    function need(from, where) { if (!names[from]) issues.push(where + ' uses "' + from + '" but no read with that name is declared in the header.'); }
    allInlines(model).forEach(function (n) {
      if (n.t !== 'bind') return;
      var root = n.ref.split('.')[0]; need(root, 'The value {{' + n.ref + '}}');
      if (!FORMATS[n.fmt]) issues.push('Unknown format "' + n.fmt + '" in {{' + n.ref + '}}.');
      n.ref.split('.').forEach(function (seg) { if (FORBIDDEN_DISPLAY.test(seg)) issues.push('"' + seg + '" is internal and cannot be shown.'); });
    });
    model.blocks.forEach(function (b) {
      if (b.type === 'vtable' || b.type === 'vchart') {
        need(b.spec && b.spec.from, 'A ' + b.type + ' block');
        var cols = (b.spec.columns || []).map(function (c) { return c.field; }).concat([b.spec.x, b.spec.y, b.spec.series]);
        (b.spec.columns || []).forEach(function (c) { if (c.unitField) cols.push(c.unitField); });
        cols.forEach(function (f) { if (f != null && FORBIDDEN_DISPLAY.test(String(f))) issues.push('"' + f + '" is internal and cannot be shown.'); });
        if (b.type === 'vtable' && !(b.spec.columns && b.spec.columns.length)) issues.push('A vtable block needs columns.');
        if (b.type === 'vchart' && !(b.spec.x && b.spec.y)) issues.push('A vchart block needs x and y.');
        if (b.type === 'vchart' && b.spec.type && b.spec.type !== 'bar' && b.spec.type !== 'line') issues.push('Chart type must be bar or line.');
      }
      if (b.type === 'vstats') {
        if (!Array.isArray(b.spec)) issues.push('A vstats block must be a list.');
        else b.spec.forEach(function (s) { need(s.from, 'A vstats item'); if (s.path && s.path.split('.').some(function (x) { return FORBIDDEN_DISPLAY.test(x); })) issues.push('"' + s.path + '" is internal and cannot be shown.'); });
      }
      if (b.type === 'mermaid') {
        if (/<\s*script|javascript:|\bclick\s+\w+|%%\{\s*init|\bhref\b|<\s*img|<\s*iframe|onerror|onload/i.test(b.text)) issues.push('A diagram contains something that is not allowed (script, click, link, init).');
        if (b.text.length > 6000) issues.push('A diagram is too long (6000 characters).');
      }
    });
    return issues;
  }

  // ---- data access -----------------------------------------------------------------------------------------------
  function getPath(data, ref) {
    var parts = ref.split('.'), cur = data[parts[0]];
    for (var k = 1; k < parts.length; k++) {
      if (cur == null) return undefined;
      if (parts[k] === 'count' && cur && Array.isArray(cur.rows) && cur.count === undefined) return cur.rows.length;
      cur = cur[parts[k]];
    }
    return cur;
  }
  function inlineText(inlines, data) {
    return flat(inlines).map(function (n) { return n.t === 'bind' ? formatValue(getPath(data, n.ref), n.fmt) : n.v; }).join('');
  }
  function cellValue(row, col) { return formatValue(row[col.field], col.format, col.unitField ? row[col.unitField] : undefined); }
  function substituteBindings(text, data) {
    return text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*(?:\|\s*([a-z]+))?\s*\}\}/g, function (_, ref, f) { return formatValue(getPath(data, ref), f || 'text'); });
  }

  // $row.field inside a button prefill
  function rowPrefill(prefill, row) {
    if (typeof prefill === 'string') { var m = /^\$row\.([A-Za-z0-9_]+)$/.exec(prefill); return m ? row[m[1]] : prefill; }
    if (Array.isArray(prefill)) return prefill.map(function (x) { return rowPrefill(x, row); });
    if (prefill && typeof prefill === 'object') { var o = {}; Object.keys(prefill).forEach(function (k) { o[k] = rowPrefill(prefill[k], row); }); return o; }
    return prefill;
  }

  function hasOwnH1(model) { return model.blocks.length > 0 && model.blocks[0].type === 'h' && model.blocks[0].level === 1; }

  // ---- plain-text resolution (Markdown export, Word export, truth tests) -----------------------------------------
  // Backslash-escape everything Markdown could act on. Used for Word export, where pandoc would otherwise turn a database
  // value like  ![x](/etc/passwd)  into an image (a file read) — values from the database are DATA, never markup.
  function mdEsc(s) { return String(s).replace(/([\\`*_{}\[\]()#+!|<>~$&])/g, '\\$1').replace(/^(\s*)(-|\d+[.)])(\s)/, '$1\\$2$3'); }

  function toMarkdown(model, data, opts) {
    var images = (opts && opts.images) || {}, E = opts && opts.escape ? mdEsc : function (x) { return String(x); };
    var out = [];
    if (model.title && !hasOwnH1(model)) out.push('# ' + E(model.title) + '\n');
    var inl = function (a) { return a.map(function (n) { return n.t === 'bind' ? E(formatValue(getPath(data, n.ref), n.fmt)) : n.t === 'b' ? '**' + inl(n.kids) + '**' : n.t === 'i' ? '*' + inl(n.kids) + '*' : n.t === 'code' ? '`' + n.v + '`' : E(n.v); }).join(''); };
    var cell = function (r, c) { return E(cellValue(r, c)); };
    model.blocks.forEach(function (b, idx) {
      if (images[idx] && (b.type === 'vchart' || b.type === 'mermaid')) { out.push('![' + E(b.type === 'vchart' ? (b.spec.title || 'Chart') : 'Diagram') + '](' + images[idx] + ')\n'); return; }
      if (b.type === 'h') out.push('#'.repeat(b.level) + ' ' + inl(b.inlines) + '\n');
      else if (b.type === 'p') out.push(inl(b.inlines) + '\n');
      else if (b.type === 'quote') out.push('> ' + inl(b.inlines) + '\n');
      else if (b.type === 'hr') out.push('---\n');
      else if (b.type === 'code') out.push('```\n' + b.text + '\n```\n');
      else if (b.type === 'list') out.push(b.items.map(function (it, k) { return (b.ordered ? (k + 1) + '. ' : '- ') + inl(it); }).join('\n') + '\n');
      else if (b.type === 'table') out.push('| ' + b.head.map(inl).join(' | ') + ' |\n|' + b.head.map(function () { return '---|'; }).join('') + '\n' + b.rows.map(function (r) { return '| ' + r.map(inl).join(' | ') + ' |'; }).join('\n') + '\n');
      else if (b.type === 'vtable') {
        var res = data[b.spec.from] || { rows: [] }, cols = b.spec.columns;
        out.push('| ' + cols.map(function (c) { return E(c.label || c.field); }).join(' | ') + ' |\n|' + cols.map(function () { return '---|'; }).join('') + '\n' +
          res.rows.map(function (r) { return '| ' + cols.map(function (c) { return cell(r, c); }).join(' | ') + ' |'; }).join('\n') + '\n');
      } else if (b.type === 'vstats') out.push(b.spec.map(function (s) { return '**' + E(s.label) + ':** ' + E(formatValue(getPath(data, s.from + '.' + s.path), s.format)); }).join('  \n') + '\n');
      else if (b.type === 'vchart') {
        var rs = data[b.spec.from] || { rows: [] };
        out.push((b.spec.title ? '**' + E(b.spec.title) + '**\n\n' : '') + '| ' + E(b.spec.x) + ' | ' + E(b.spec.y) + ' |\n|---|---|\n' + rs.rows.map(function (r) { return '| ' + E(r[b.spec.x]) + ' | ' + E(formatValue(r[b.spec.y], b.spec.format)) + ' |'; }).join('\n') + '\n');
      } else if (b.type === 'mermaid') out.push('```mermaid\n' + substituteBindings(b.text, data) + '\n```\n');
    });
    return out.join('\n');
  }

  return { parse: parse, validate: validate, fmt: fmt, formatValue: formatValue, getPath: getPath, inlineText: inlineText, cellValue: cellValue,
           substituteBindings: substituteBindings, rowPrefill: rowPrefill, toMarkdown: toMarkdown, mdEsc: mdEsc, allInlines: allInlines, hasOwnH1: hasOwnH1, FORBIDDEN_DISPLAY: FORBIDDEN_DISPLAY };
});
