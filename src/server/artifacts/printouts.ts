import { chromium } from 'playwright-core';
import { dateText, groupIndian, inr, qty } from '@/lib/format';
import { CHROME_ARGS, chromePath, ExportError } from './export';

/**
 * The five printouts (docs/ARTIFACTS.md §9): code-owned templates with the Vijaya letterhead, filled with facts read as the
 * person asking. The model can open them and can never write or change them. Every piece of data is escaped; nothing here
 * loads anything from outside. The same HTML is the preview in the panel (a frame with no script at all) and the PDF.
 */
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
/** Up to d decimals, no trailing zeros, Indian grouping. */
const num = (n: number, d = 4) => groupIndian(Number(n.toFixed(d)));
const dt = (iso: string | null | undefined) => (iso ? dateText(new Date(iso)) : '');

interface Company { name: string; address: string; gstin: string; state: string; phone: string }
export interface Printed { title: string; html: string; filename: string }

const CSS = `
@page{size:A4;margin:14mm 12mm}
*{box-sizing:border-box}
html{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1B2A38;background:#fff}
body{margin:0;padding:14px 18px}
.head{display:flex;justify-content:space-between;gap:16px;border-bottom:3px solid #A8571E;padding-bottom:8px;margin-bottom:12px}
.co{font-size:20px;font-weight:700;letter-spacing:.2px}.muted{color:#4B5C6B}
.doc{text-align:right}.doc h1{margin:0;font-size:17px;letter-spacing:1px}
.stamp{display:inline-block;margin-top:6px;border:2px dashed #A63A2E;color:#A63A2E;font-weight:700;padding:2px 10px;transform:rotate(-3deg);letter-spacing:1px}
.cols{display:flex;gap:16px;margin-bottom:12px}.box{flex:1;border:1px solid #D6CDB8;padding:8px 10px;border-radius:3px}
.box h2{margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:#4B5C6B}
table{width:100%;border-collapse:collapse;margin:6px 0 10px}th,td{border:1px solid #D6CDB8;padding:5px 7px;vertical-align:top}
th{background:#ECE7DC;text-align:left;font-weight:600}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
td.blank{height:26px}.totals{width:46%;margin-left:auto}.totals td{border:0;border-bottom:1px solid #D6CDB8}.totals tr.grand td{font-weight:700;border-top:2px solid #1B2A38}
.note{margin:8px 0;color:#4B5C6B}.sign{display:flex;gap:24px;margin-top:38px}.sign div{flex:1;border-top:1px solid #1B2A38;padding-top:4px;color:#4B5C6B}
.foot{margin-top:18px;font-size:11px;color:#66727F;border-top:1px solid #D6CDB8;padding-top:6px}
@media print{html,body{background:#fff}}`;

const doc = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>` +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body>${body}</body></html>`;

const letterhead = (co: Company, title: string, number: string, date: string, extra = '') => `
<div class="head"><div><div class="co">${esc(co.name)}</div>
<div class="muted">${esc(co.address)}${co.address && co.phone ? ' · ' : ''}${esc(co.phone ? `Phone ${co.phone}` : '')}</div>
${co.gstin ? `<div class="muted">GSTIN ${esc(co.gstin)}${co.state ? ` · ${esc(co.state)}` : ''}</div>` : ''}</div>
<div class="doc"><h1>${esc(title)}</h1><div><strong>${esc(number)}</strong></div><div class="muted">${esc(date)}</div>${extra}</div></div>`;

const party = (label: string, p: { name: string; address: string; state: string; gstin: string; phone: string }) =>
  `<div class="box"><h2>${esc(label)}</h2><strong>${esc(p.name)}</strong><br>${esc(p.address)}${p.state ? `<br>${esc(p.state)}` : ''}${p.gstin ? `<br>GSTIN ${esc(p.gstin)}` : ''}${p.phone ? `<br>Phone ${esc(p.phone)}` : ''}</div>`;
const row = (cells: (string | number)[], right: number[] = []) => `<tr>${cells.map((c, i) => `<${right.includes(i) ? 'td class="n"' : 'td'}>${esc(c)}</td>`).join('')}</tr>`;
const head = (cols: string[], right: number[] = []) => `<tr>${cols.map((c, i) => `<th${right.includes(i) ? ' class="n"' : ''}>${esc(c)}</th>`).join('')}</tr>`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/* eslint-disable @typescript-eslint/no-explicit-any */
export function renderPrintout(d: any): Printed {
  const co: Company = d.company;
  if (d.template === 'purchase-order') {
    const stamp = d.po.approved ? '' : '<div class="stamp">NOT APPROVED</div>';
    const tax = d.taxMode === 'CGST_SGST' ? `<tr><td>CGST</td><td class="n">${esc(inr(d.gst / 2))}</td></tr><tr><td>SGST</td><td class="n">${esc(inr(d.gst / 2))}</td></tr>` : d.taxMode === 'IGST' ? `<tr><td>IGST</td><td class="n">${esc(inr(d.gst))}</td></tr>` : '';
    const body = letterhead(co, 'PURCHASE ORDER', d.po.number, dt(d.po.date), stamp) +
      `<div class="cols">${party('To (supplier)', d.supplier)}${party('Bill to', { name: co.name, address: co.address, state: co.state, gstin: co.gstin, phone: co.phone })}</div>` +
      `<table>${head(['#', 'Material', 'HSN', 'Quantity', 'Unit', 'Rate', 'GST', 'Amount'], [0, 3, 5, 6, 7])}${d.lines.map((l: any) => row([l.n, l.material, l.hsn, num(l.quantity), unit(l.unit), inr(l.rate), l.gstRate ? `${l.gstRate}%` : '', inr(l.amount)], [0, 3, 5, 6, 7])).join('')}</table>` +
      `<table class="totals"><tr><td>Sub-total</td><td class="n">${esc(inr(d.subTotal))}</td></tr>${tax}<tr class="grand"><td>Total</td><td class="n">${esc(inr(d.total))}</td></tr></table>` +
      (d.po.expected ? `<div class="note">Please deliver by ${esc(dt(d.po.expected))}.</div>` : '') +
      `<div class="sign"><div>Prepared by</div><div>Authorised signatory, ${esc(co.name)}</div></div>`;
    return { title: `Purchase order ${d.po.number}`, html: doc(`Purchase order ${d.po.number}`, body), filename: `purchase-order-${slug(d.po.number)}` };
  }
  if (d.template === 'goods-receipt-note') {
    const body = letterhead(co, 'GOODS RECEIPT NOTE', d.grn.number, dt(d.grn.date)) +
      `<div class="cols">${party('Received from', d.supplier)}<div class="box"><h2>Delivery</h2>${d.grn.po ? `Against ${esc(d.grn.po)}<br>` : 'No purchase order<br>'}${d.grn.invoiceNo ? `Invoice ${esc(d.grn.invoiceNo)}${d.grn.invoiceDate ? ` of ${esc(dt(d.grn.invoiceDate))}` : ''}<br>` : ''}${d.grn.challanNo ? `Challan ${esc(d.grn.challanNo)}` : ''}</div></div>` +
      `<table>${head(['#', 'Material', 'Arrived', 'Accepted', 'Sent back', 'Why', 'Rate'], [0, 2, 3, 4, 6])}${d.lines.map((l: any) => row([l.n, l.material, qty(l.received, l.unit), qty(l.accepted, l.unit), l.rejected ? qty(l.rejected, l.unit) : '', l.reason, inr(l.rate)], [0, 2, 3, 4, 6])).join('')}</table>` +
      `<div class="note">Only the accepted quantity goes into stock.</div><div class="sign"><div>Received by</div><div>Checked by</div></div>`;
    return { title: `Goods receipt note ${d.grn.number}`, html: doc(`Goods receipt note ${d.grn.number}`, body), filename: `goods-receipt-note-${slug(d.grn.number)}` };
  }
  if (d.template === 'issue-slip') {
    const body = letterhead(co, 'ISSUE SLIP · PICK LIST', d.job.number, dt(new Date().toISOString())) +
      `<div class="cols"><div class="box"><h2>Job</h2><strong>${esc(d.job.customer)}</strong>${d.job.customerPo ? ` · PO ${esc(d.job.customerPo)}` : ''}<br>${esc(d.job.product)}<br>${esc(groupIndian(d.job.pieces))} pieces${d.job.due ? ` · due ${esc(dt(d.job.due))}` : ''}</div></div>` +
      `<table>${head(['#', 'Material', 'Needed for the job', 'Given out already', 'Give now', 'Shelf', 'Done'], [0, 2, 3, 4])}${d.lines.map((l: any) => `<tr>${[l.n, l.material, qty(l.required, l.unit), l.issued ? qty(l.issued, l.unit) : '–', qty(l.toIssue, l.unit)].map((c, i) => `<td${[0, 2, 3, 4].includes(i) ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}<td class="blank"></td><td class="blank"></td></tr>`).join('')}</table>` +
      `<div class="note">Weigh or count out exactly what is written. Printing this gives out nothing: record it in the app before you leave the shelf.</div><div class="sign"><div>Given by</div><div>Received by</div></div>`;
    return { title: `Issue slip ${d.job.number}`, html: doc(`Issue slip ${d.job.number}`, body), filename: `issue-slip-${slug(d.job.number)}` };
  }
  if (d.template === 'count-sheet') {
    const opening = d.count.opening;
    const cols = opening ? ['#', 'Material', 'Unit', 'Counted', 'Rate (₹)', 'Invoice no.'] : ['#', 'Material', 'Unit', 'System', 'Counted', 'Note'];
    const rows = d.lines.map((l: any) => opening
      ? `<tr><td class="n">${l.n}</td><td>${esc(l.material)}</td><td>${esc(unit(l.unit))}</td><td class="blank"></td><td class="blank"></td><td class="blank"></td></tr>`
      : `<tr><td class="n">${l.n}</td><td>${esc(l.material)}</td><td>${esc(unit(l.unit))}</td><td class="n">${esc(num(l.system ?? 0))}</td><td class="blank"></td><td class="blank"></td></tr>`).join('');
    const body = letterhead(co, opening ? 'OPENING COUNT SHEET' : 'COUNT SHEET', d.count.number, dt(d.count.date)) +
      `<table>${head(cols, opening ? [0] : [0, 3])}${rows}</table>` +
      `<div class="note">${opening ? 'Write what you counted and the rate from the last purchase invoice.' : 'The System column is what the app says there should be. Write what you counted in the Counted column, then enter it in the app.'}</div><div class="sign"><div>Counted by</div><div>Checked by</div></div>`;
    return { title: `Count sheet ${d.count.number}`, html: doc(`Count sheet ${d.count.number}`, body), filename: `count-sheet-${slug(d.count.number)}` };
  }
  // job-cost-sheet (owner only)
  const closed = d.job.status === 'CLOSED';
  const body = letterhead(co, 'JOB COST SHEET', d.job.number, closed ? `Closed ${dt(d.job.closedAt)}` : 'Cost so far') +
    `<div class="cols"><div class="box"><h2>Job</h2><strong>${esc(d.job.customer)}</strong>${d.job.customerPo ? ` · PO ${esc(d.job.customerPo)}` : ''}<br>${esc(d.job.product)}<br>${esc(groupIndian(d.job.pieces))} pieces</div></div>` +
    `<table>${head(['Material', 'Given out', 'Came back', 'Used', 'Value'], [1, 2, 3, 4])}${d.lines.map((l: any) => row([l.material, qty(l.issued, l.unit), l.returned ? qty(l.returned, l.unit) : '–', qty(l.net, l.unit), inr(l.value)], [1, 2, 3, 4])).join('')}</table>` +
    `<table class="totals"><tr><td>Material cost</td><td class="n">${esc(inr(d.cost))}</td></tr>${d.perPiece !== null ? `<tr class="grand"><td>Per piece</td><td class="n">${esc(inr(d.perPiece))}</td></tr>` : ''}</table>` +
    `<div class="foot">For the owner only. Value is quantity at the average price when it went out or came back.</div>`;
  return { title: `Job cost sheet ${d.job.number}`, html: doc(`Job cost sheet ${d.job.number}`, body), filename: `job-cost-sheet-${slug(d.job.number)}` };
}

const unit = (u: string) => ({ KG: 'kg', NOS: 'pcs', MTR: 'm', LTR: 'L', ROLL: 'roll', SET: 'set' } as Record<string, string>)[u] ?? u.toLowerCase();

/** A4 PDF from the printout's own HTML, in headless Chromium with every request refused: if anything tried to leave, nothing is returned. */
export async function printoutPdf(html: string): Promise<Buffer> {
  const browser = await chromium.launch({ executablePath: chromePath(), args: CHROME_ARGS });
  const leaked: string[] = [];
  try {
    const ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.startsWith('about:') || u.startsWith('data:')) return r.continue(); leaked.push(u); return r.abort(); });
    const page = await ctx.newPage();
    await page.emulateMedia({ media: 'print' });
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 });
    const pdf = Buffer.from(await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } }));
    if (leaked.length) throw new ExportError('LEAK', 'Printout blocked: it tried to reach the network.');
    return pdf;
  } finally { await browser.close(); }
}
