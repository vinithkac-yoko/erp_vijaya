import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { addGrn, addJob, addMaterials, addParties, addPo, addStock, prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 120_000 });

const say = async (page: Page, text: string) => {
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Type a message').fill(text);
  await page.getByLabel('Type a message').press('Enter');
};
const pdfText = (bytes: Buffer) => { const f = `/tmp/vp-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`; writeFileSync(f, bytes); try { return execFileSync('pdftotext', [f, '-'], { timeout: 30_000 }).toString(); } finally { rmSync(f, { force: true }); } };

async function seed() {
  await addParties([{ name: 'Sundaram Ferrites', kind: 'supplier' }, { name: 'Ashok Transformers' }]);
  await addMaterials([{ name: '22 SWG Copper Wire', uom: 'KG' }, { name: 'Ferrite Core E-30' }]);
  await addStock('22 SWG Copper Wire', 100, 800);
  await prisma.party.update({ where: { nameKey: 'sundaramferrites' }, data: { gstin: '33AAACS1234K1Z2', state: 'Tamil Nadu', city: 'Chennai' } });
  await addPo('Sundaram Ferrites', [{ material: 'Ferrite Core E-30', quantity: 982, rate: 65, gstRate: 18, hsn: '8505' }], { status: 'PENDING_APPROVAL' });
  await addGrn('Sundaram Ferrites', [{ material: '22 SWG Copper Wire', received: 50, rejected: 3, rate: 812 }], { invoiceNo: 'SF/2627/0441' });
  const job = await addJob('Ashok Transformers', 10, [{ material: '22 SWG Copper Wire', perPiece: 0.5 }]);
  const wire = await prisma.material.findFirstOrThrow({ where: { name: '22 SWG Copper Wire' } });
  await prisma.stockMovement.create({ data: { materialId: wire.id, type: 'ISSUE', direction: 'OUT', quantity: 5, rate: 800, jobId: job.id, movementDate: new Date() } });
  const count = await prisma.stockCount.create({ data: { number: 'CNT-2627-0001', countDate: new Date() } });
  await prisma.stockCountLine.create({ data: { stockCountId: count.id, materialId: wire.id, systemQty: 145 } });
}

test.describe('the five printouts (ARTIFACTS §9)', () => {
  test('the purchase order opens beside the chat with the letterhead and a NOT APPROVED mark; its PDF has the same words; Print and Download PDF work', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await say(page, 'print the po');
    const panel = page.getByTestId('printout-panel');
    await expect(panel).toBeVisible();
    const frame = page.frameLocator('iframe[title="Purchase order PO-2627-0001"]');
    await expect(frame.locator('body')).toContainText('PURCHASE ORDER');
    await expect(frame.locator('body')).toContainText('Sundaram Ferrites');
    await expect(frame.locator('body')).toContainText('GSTIN 33AAACS1234K1Z2');
    await expect(frame.locator('body')).toContainText('NOT APPROVED');
    await expect(frame.locator('body')).toContainText('982');
    // Print opens the PDF in its own tab (a frame cannot open it: the page allows no frames but its own)
    await expect(page.getByRole('link', { name: 'Print' })).toHaveAttribute('target', '_blank');
    const res = await page.request.get('/api/printouts/purchase-order?purchaseOrder=PO-2627-0001');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
    expect(res.headers()['content-disposition']).toMatch(/^inline/);
    const body = await res.body();
    expect(body.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdfText(body)).toContain('PO-2627-0001');
    expect(pdfText(body).replace(/\s+/g, '')).toContain('NOTAPPROVED');   // the mark is letter-spaced, so the PDF breaks it into pieces
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF' }).click()]);
    expect(download.suggestedFilename()).toBe('purchase-order-po-2627-0001.pdf');
    expect(readFileSync(await download.path()).subarray(0, 4).toString()).toBe('%PDF');
    expect(await prisma.auditEvent.count({ where: { action: 'PRINT' } })).toBeGreaterThanOrEqual(2);
  });

  test('the goods receipt note, the issue slip and the count sheet each open as a printout and as a PDF', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    for (const [ask, title, words] of [
      ['print the grn', 'Goods receipt note GRN-2627-0001', ['GOODS RECEIPT NOTE', '50 kg', '47 kg', 'SF/2627/0441']],
      ['print the issue slip', 'Issue slip JOB-2627-0001', ['ISSUE SLIP', '22 SWG Copper Wire', '5 kg']],
      ['print the count sheet', 'Count sheet CNT-2627-0001', ['COUNT SHEET', 'System', '145']],
    ] as const) {
      await say(page, ask);
      const frame = page.frameLocator(`iframe[title="${title}"]`);
      for (const w of words) await expect(frame.locator('body')).toContainText(w);
    }
    for (const [url, word] of [['/api/printouts/goods-receipt-note?receipt=GRN-2627-0001', 'GRN-2627-0001'], ['/api/printouts/issue-slip?job=JOB-2627-0001', 'JOB-2627-0001'], ['/api/printouts/count-sheet?count=CNT-2627-0001', 'CNT-2627-0001']] as const) {
      const res = await page.request.get(url);
      expect(res.status()).toBe(200);
      expect(pdfText(await res.body())).toContain(word);
    }
  });

  test('the job cost sheet is the owner\'s: the owner gets the cost; the storekeeper is told no and the file is refused', async ({ page, browser }) => {
    await seed();
    await login(page, STOREKEEPER);
    await say(page, 'print the cost sheet');
    await expect(page.getByText('The printout is open.')).toBeVisible();
    await expect(page.getByTestId('printout-panel')).toHaveCount(0);
    expect((await page.request.get('/api/printouts/job-cost-sheet?job=JOB-2627-0001')).status()).toBe(403);
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const owner = await ctx.newPage();
    await login(owner, OWNER);
    await say(owner, 'print the cost sheet');
    const frame = owner.frameLocator('iframe[title="Job cost sheet JOB-2627-0001"]');
    await expect(frame.locator('body')).toContainText('JOB COST SHEET');
    await expect(frame.locator('body')).toContainText(/Material cost\s*₹4,020/);
    await expect(frame.locator('body')).toContainText(/Per piece\s*₹402/);
    expect(pdfText(await (await owner.request.get('/api/printouts/job-cost-sheet?job=JOB-2627-0001')).body())).toContain('₹4,020');
    await ctx.close();
  });

  test('a printout nobody can make is refused: no tax invoice, a number that is not there is "couldn\'t find"', async ({ page }) => {
    await seed();
    await login(page, OWNER);
    expect((await page.request.get('/api/printouts/tax-invoice?job=1')).status()).toBe(403);
    const missing = await page.request.get('/api/printouts/purchase-order?purchaseOrder=999');
    expect(missing.status()).toBe(404);
    expect((await missing.json()).error).toMatch(/Couldn't find that purchase order/);
    expect((await page.request.get('/api/printouts/purchase-order')).status()).toBe(404);
  });

  test('the printout preview passes the accessibility scan in light and dark and shows a letterhead', async ({ page }) => {
    await seed();
    await login(page, OWNER);
    await say(page, 'print the po');
    await expect(page.getByTestId('printout-panel')).toBeVisible();
    // the paper itself is a fixed template in a frame that runs no script (so the scanner cannot enter it); its words are checked here
    await expect(page.frameLocator('iframe[title="Purchase order PO-2627-0001"]').locator('body')).toContainText('Vijaya Electronics');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const r = await new AxeBuilder({ page }).include('[data-testid="printout-panel"]').exclude('iframe').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    }
  });
});
