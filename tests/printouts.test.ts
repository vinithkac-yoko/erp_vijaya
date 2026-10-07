import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runTool } from '@/server/tools';
import { chromePath, ExportError } from '@/server/artifacts/export';
import { printoutPdf, renderPrintout } from '@/server/artifacts/printouts';
import { balance, makeJob, makeMaterial, makeParty, makeCount, addLine, prisma, receive, resetDb, issue, giveBack } from './helpers/db';
import { fails, ok, owner, save, seedSettings, storekeeper } from './helpers/tools';

beforeEach(async () => { await resetDb(); await seedSettings(); });
afterAll(() => prisma.$disconnect());

const company = { name: 'Vijaya Electronics', address: '12 Industrial Estate, Chennai 600058', gstin: '33ABCDE1234F1Z5', state: 'Tamil Nadu', phone: '044-1234567' };
const hostile = '<img src=x onerror=alert(1)> & "quotes"';
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

const poData = (over: Record<string, unknown> = {}) => ({
  template: 'purchase-order', company, taxMode: 'CGST_SGST',
  po: { number: 'PO-2627-0015', date: '2026-10-07T00:00:00Z', approved: true, status: 'APPROVED', expected: '2026-10-20T00:00:00Z', job: null, approvedAt: null },
  supplier: { name: 'Sundaram Ferrites', address: 'Chennai 600001', state: 'Tamil Nadu', gstin: '33AAACS1234K1Z2', phone: '' },
  lines: [{ n: 1, material: 'Ferrite Core E-30', hsn: '8505', unit: 'NOS', quantity: 982, rate: 65, gstRate: 18, amount: 63830 }],
  subTotal: 63830, gst: 11489.4, total: 75319.4, ...over,
});

describe('the five printouts are fixed templates (ARTIFACTS §9)', () => {
  it('a purchase order has the letterhead, the supplier\'s GSTIN, the HSN, CGST and SGST for the same state, and a signature block', () => {
    const p = renderPrintout(poData());
    const t = text(p.html);
    expect(t).toContain('Vijaya Electronics');
    expect(t).toContain('GSTIN 33ABCDE1234F1Z5');
    expect(t).toContain('GSTIN 33AAACS1234K1Z2');
    expect(t).toContain('PURCHASE ORDER');
    expect(t).toContain('8505');
    expect(t).toContain('982');
    expect(t).toContain('CGST ₹5,744.70');
    expect(t).toContain('SGST ₹5,744.70');
    expect(t).toContain('Total ₹75,319.40');
    expect(t).toContain('Authorised signatory');
    expect(t).not.toContain('NOT APPROVED');
    expect(p.filename).toBe('purchase-order-po-2627-0015');
  });
  it('IGST for another state, no tax rows when no line has GST, and a NOT APPROVED mark until the owner approves', () => {
    expect(text(renderPrintout(poData({ taxMode: 'IGST' })).html)).toContain('IGST ₹11,489.40');
    const none = text(renderPrintout(poData({ taxMode: 'NONE', gst: 0, total: 63830 })).html);
    expect(none).not.toMatch(/CGST|SGST|IGST/);
    const un = renderPrintout(poData({ po: { ...poData().po, approved: false, status: 'PENDING_APPROVAL' } }));
    expect(un.html).toContain('NOT APPROVED');
  });
  it('a goods receipt note splits what arrived from what was accepted and says only the accepted goes into stock', () => {
    const t = text(renderPrintout({ template: 'goods-receipt-note', company, grn: { number: 'GRN-2627-0003', date: '2026-10-07T00:00:00Z', po: 'PO-2627-0015', invoiceNo: 'SF/2627/0441', invoiceDate: '2026-10-06T00:00:00Z', challanNo: 'DC-9' },
      supplier: { name: 'Sundaram Ferrites', address: '', state: '', gstin: '', phone: '' },
      lines: [{ n: 1, material: '22 SWG Copper Wire', unit: 'KG', received: 50, accepted: 47, rejected: 3, reason: 'Damaged in transit', rate: 812 }] }).html);
    expect(t).toContain('GOODS RECEIPT NOTE');
    expect(t).toContain('50 kg');
    expect(t).toContain('47 kg');
    expect(t).toContain('3 kg');
    expect(t).toContain('Damaged in transit');
    expect(t).toContain('Invoice SF/2627/0441');
    expect(t).toContain('Only the accepted quantity goes into stock');
  });
  it('the issue slip is a pick list with empty Shelf and Done boxes and says printing gives out nothing', () => {
    const p = renderPrintout({ template: 'issue-slip', company, job: { number: 'JOB-2627-0031', customer: 'Ashok Transformers', customerPo: '', product: 'SMPS transformer', pieces: 500, date: '', due: null, status: 'OPEN', closedAt: null },
      lines: [{ n: 1, material: '22 SWG Copper Wire', unit: 'KG', required: 9.2, issued: 0, toIssue: 9.2 }] });
    const t = text(p.html);
    expect(t).toContain('ISSUE SLIP');
    expect(t).toContain('9.2 kg');
    expect(t).toContain('Printing this gives out nothing');
    expect((p.html.match(/class="blank"/g) ?? []).length).toBe(2);
  });
  it('the count sheet shows the System column and an empty Counted column; the opening count has Counted, Rate and Invoice instead', () => {
    const monthly = renderPrintout({ template: 'count-sheet', company, count: { number: 'CNT-2627-0002', date: '2026-10-07T00:00:00Z', opening: false, status: 'DRAFT' }, lines: [{ n: 1, material: 'Bobbin Type-B', unit: 'NOS', system: 652 }] });
    expect(text(monthly.html)).toContain('System');
    expect(text(monthly.html)).toContain('Counted');
    expect(text(monthly.html)).toContain('652');
    const opening = renderPrintout({ template: 'count-sheet', company, count: { number: 'CNT-2627-0001', date: '2026-10-07T00:00:00Z', opening: true, status: 'DRAFT' }, lines: [{ n: 1, material: 'Bobbin Type-B', unit: 'NOS', system: null }] });
    expect(text(opening.html)).toContain('Rate (₹)');
    expect(text(opening.html)).not.toContain('System');
  });
  it('the job cost sheet shows cost and cost per piece, for the owner', () => {
    const t = text(renderPrintout({ template: 'job-cost-sheet', company, job: { number: 'JOB-2627-0031', customer: 'Ashok', customerPo: '', product: 'x', pieces: 100, date: '', due: null, status: 'CLOSED', closedAt: '2026-10-07T00:00:00Z' },
      lines: [{ material: 'Wire', unit: 'KG', issued: 100, returned: 10, net: 90, value: 4000 }], cost: 4000, perPiece: 40 }).html);
    expect(t).toContain('JOB COST SHEET');
    expect(t).toContain('Material cost ₹4,000');
    expect(t).toContain('Per piece ₹40');
    expect(t).toContain('For the owner only');
  });

  it('everything from the database is text: a hostile name cannot make markup, and the page can load nothing', () => {
    const p = renderPrintout(poData({ supplier: { name: hostile, address: hostile, state: '', gstin: '', phone: '' }, lines: [{ n: 1, material: hostile, hsn: hostile, unit: 'NOS', quantity: 1, rate: 1, gstRate: 0, amount: 1 }], po: { ...poData().po, number: hostile } }));
    expect(p.html).not.toContain('<img');
    expect(p.html).not.toContain('onerror=alert(1)>');
    expect(p.html).toContain('&lt;img src=x');
    expect(p.html).toContain("default-src 'none'");
    expect(p.html).not.toMatch(/<script|<link|<iframe|src=["']http/i);
  });
});

describe('printouts read their facts through the gateway, as the person asking', () => {
  it('a purchase order by its number carries the supplier\'s details and the company\'s letterhead from Settings, and no id or code', async () => {
    const o = await owner();
    await ok(save(o, 'update_setting', { key: 'company.name', value: 'Vijaya Electronics Pvt' }));
    await ok(save(o, 'update_setting', { key: 'company.state', value: 'Tamil Nadu' }));
    const sup = await makeParty('supplier', { name: 'Sundaram Ferrites', gstin: '33AAACS1234K1Z2', state: 'Tamil Nadu', city: 'Chennai', pincode: '600001' });
    const m = await makeMaterial({ name: 'Ferrite Core E-30', uom: 'NOS' });
    await prisma.purchaseOrder.create({ data: { number: 'PO-2627-0015', supplierId: sup.id, poDate: new Date(), status: 'APPROVED', subTotal: 6500, gstAmount: 1170, totalValue: 7670, lines: { create: [{ materialId: m.id, quantity: 100, rate: 65, amount: 6500, hsnCode: '8505', gstRate: 18 }] } } });
    const r = await ok<Record<string, unknown>>(runTool(await storekeeper(), 'get_print_data', { template: 'purchase-order', purchaseOrderId: '15' }));
    expect(r).toMatchObject({ taxMode: 'CGST_SGST', company: { name: 'Vijaya Electronics Pvt', state: 'Tamil Nadu' }, supplier: { name: 'Sundaram Ferrites', gstin: '33AAACS1234K1Z2' }, total: 7670 });
    const html = renderPrintout(r).html;
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(html).not.toMatch(/\b(MAT|PTY)-\d+/);
  });

  it('the issue slip lists what the BOM still needs; the count sheet shows the frozen System quantity', async () => {
    const wire = await makeMaterial({ name: 'Wire', uom: 'KG' });
    await receive(wire.id, 100, 800);
    const job = await makeJob({ number: 'JOB-2627-0031', quantity: 10 });
    await prisma.jobBomLine.create({ data: { jobId: job.id, materialId: wire.id, qtyPerPiece: 0.5, requiredQty: 5, issuedQty: 2 } });
    const slip = await ok<{ lines: { toIssue: number; issued: number }[] }>(runTool(await storekeeper(), 'get_print_data', { template: 'issue-slip', jobId: '31' }));
    expect(slip.lines[0]).toMatchObject({ required: 5, issued: 2, toIssue: 3 });
    const c = await makeCount();
    await addLine(c.id, wire.id, { system: 100 });
    const sheet = await ok<{ count: { opening: boolean }; lines: { system: number }[] }>(runTool(await storekeeper(), 'get_print_data', { template: 'count-sheet', countId: c.number }));
    expect(sheet.lines[0]?.system).toBe(100);
    // with no count named it is the one being counted
    expect((await ok<{ count: { number: string } }>(runTool(await storekeeper(), 'get_print_data', { template: 'count-sheet' }))).count.number).toBe(c.number);
  });

  it('the job cost sheet is the owner\'s: the storekeeper is refused by the tool itself, and the owner gets the cost from the ledger', async () => {
    const wire = await makeMaterial({ name: 'Wire', uom: 'KG' });
    await receive(wire.id, 100, 800);
    const job = await makeJob({ number: 'JOB-2627-0031', quantity: 100 });
    await issue(wire.id, job.id, 10);
    await giveBack(wire.id, job.id, 2);
    const f = await fails(runTool(await storekeeper(), 'get_print_data', { template: 'job-cost-sheet', jobId: '31' }));
    expect(f.code).toBe('FORBIDDEN_ROLE');
    const r = await ok<{ cost: number; perPiece: number; lines: { issued: number; returned: number }[] }>(runTool(await owner(), 'get_print_data', { template: 'job-cost-sheet', jobId: '31' }));
    expect(r.cost).toBe(6400);               // 8 kg at ₹800
    expect(r.perPiece).toBe(64);
    expect(r.lines[0]).toMatchObject({ issued: 10, returned: 2 });
    expect((await balance(wire.id)).qty).toBe(92);
  });

  it('is not offered to the assistant or to an artifact: it is an internal read', async () => {
    const { registry } = await import('@/server/tools');
    const { readToolsFor } = await import('@/lib/catalog');
    expect(registry.get('get_print_data')?.agentVisible).toBe(false);
    expect(readToolsFor('OWNER')).not.toContain('get_print_data');
    expect(readToolsFor('STOREKEEPER')).not.toContain('get_print_data');
  });

  it('a missing purchase order, receipt or job is "couldn\'t find", in plain words', async () => {
    const s = await storekeeper();
    for (const input of [{ template: 'purchase-order', purchaseOrderId: '999' }, { template: 'goods-receipt-note', receiptId: '999' }, { template: 'issue-slip', jobId: '999' }]) {
      const f = await fails(runTool(s, 'get_print_data', input));
      expect(f.code).toBe('NOT_FOUND');
      expect(f.message).toMatch(/^Couldn't find that/);
    }
  });
});

const haveBrowser = (() => { try { chromePath(); return true; } catch { return false; } })();
const havePdfText = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!haveBrowser)('the PDF (needs a browser)', () => {
  it('is an A4 PDF with the number and the names in it', async () => {
    const pdf = await printoutPdf(renderPrintout(poData()).html);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    if (!havePdfText) return;
    const dir = mkdtempSync(join(tmpdir(), 'vpo-'));
    try {
      writeFileSync(join(dir, 'po.pdf'), pdf);
      const t = execFileSync('pdftotext', [join(dir, 'po.pdf'), '-'], { encoding: 'utf8', timeout: 30_000 });
      expect(t).toContain('PO-2627-0015');
      expect(t).toContain('Sundaram Ferrites');
      expect(t).toContain('₹75,319.40');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('a page that tries to reach the network is not turned into a PDF (the export fails and returns nothing)', async () => {
    const evil = '<!doctype html><html><body><img src="http://evil.test/steal.png"><p>x</p></body></html>';
    await expect(printoutPdf(evil)).rejects.toMatchObject({ code: 'LEAK' });
    await expect(printoutPdf(evil)).rejects.toBeInstanceOf(ExportError);
  }, 60_000);
});
