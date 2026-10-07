import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Download, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { addGrn, addMaterials, addParties, addPo, addStock, prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 180_000 });

/** Waits until the last answer is finished (the Stop button turns back into Send), then types. */
const say = async (page: Page, text: string) => {
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Type a message').fill(text);
  await page.getByLabel('Type a message').press('Enter');
};
const panel = (page: Page) => page.getByTestId('artifact-panel');
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Artifact tools' });

async function seed() {
  await addParties([{ name: 'Sundaram Ferrites', kind: 'supplier' }, { name: 'Ashok Transformers' }]);
  await addMaterials([{ name: '22 SWG Copper Wire', uom: 'KG' }, { name: 'Ferrite Core E-30', min: 200 }]);
  await addStock('22 SWG Copper Wire', 100, 800);   // ₹80,000
  await addStock('Ferrite Core E-30', 100, 65);     // ₹6,500, below its minimum of 200
}

/** Opens Download ▾ and takes the named format; returns the file's path. */
async function fetchFile(page: Page, label: string): Promise<{ path: string; name: string; download: Download }> {
  await toolbar(page).getByRole('button', { name: /^(Download|Preparing)/ }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: label }).click()]);
  return { path: await download.path(), name: download.suggestedFilename(), download };
}

test.describe('a document, made on request (ARTIFACTS §1.4, §3, §10)', () => {
  test('owner: the stock position opens beside the chat with live numbers, and every download has the same numbers', async ({ page, isMobile }) => {
    await seed();
    await login(page, OWNER);
    await say(page, 'make the stock position report');
    // the card is in the chat, and the panel opened because he asked
    await expect(page.getByRole('region', { name: 'Stock position, version 1' })).toBeVisible();
    await expect(panel(page)).toBeVisible();
    const frame = page.frameLocator('iframe[title="Stock position"]');
    await expect(frame.locator('#app')).toContainText('₹86,500');
    await expect(frame.locator('#app')).toContainText('1 materials are below their minimum level');
    await expect(page.locator('[data-vijaya-footer]')).toContainText(/As of \d\d:\d\d · list_reorder_alerts, get_stock_value/);
    if (isMobile) await expect(page.getByRole('button', { name: 'Back to chat' })).toBeVisible();

    const pdf = await fetchFile(page, 'PDF');
    expect(pdf.name).toMatch(/^stock-position-\d{4}-\d\d-\d\d\.pdf$/);
    expect(execFileSync('pdftotext', [pdf.path, '-'], { timeout: 30_000 }).toString()).toContain('₹86,500');

    const docx = await fetchFile(page, 'Word');
    expect(docx.name).toMatch(/\.docx$/);
    const plain = execFileSync('pandoc', ['-f', 'docx', '-t', 'plain', docx.path], { timeout: 30_000 }).toString();
    expect(plain).toContain('₹86,500');
    expect(plain).toContain('Ferrite Core E-30');

    const xlsx = await fetchFile(page, 'Excel');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(xlsx.path);
    const numbers: number[] = [];
    wb.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => { if (typeof c.value === 'number') numbers.push(c.value); })));
    expect(numbers).toContain(86500);          // a real number, not text, and no formula
    expect(numbers).toContain(100);

    const csv = await fetchFile(page, 'CSV');
    expect(readFileSync(csv.path, 'utf8')).toContain('Ferrite Core E-30');

    const md = await fetchFile(page, 'Markdown');
    expect(readFileSync(md.path, 'utf8')).toContain('₹86,500');

    const png = await fetchFile(page, 'Picture');
    const bytes = readFileSync(png.path);
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(bytes.readUInt32BE(20)).toBeGreaterThan(300); // height from the PNG header

    const rows = await prisma.auditEvent.findMany({ where: { action: 'DOWNLOAD' } });
    expect(rows).toHaveLength(6);
  });

  test('a row button opens the real form with the shortfall filled in and no rate; nothing is saved', async ({ page, isMobile }) => {
    await seed();
    await login(page, STOREKEEPER);
    await say(page, 'make a below minimum report');
    const frame = page.frameLocator('iframe[title="Below minimum"]');
    await expect(frame.locator('#app')).toContainText('Ferrite Core E-30');
    await frame.getByRole('button', { name: 'Make PO' }).click();
    if (isMobile) await expect(panel(page)).toHaveCount(0); // the sheet steps aside for the form
    const form = page.getByRole('form', { name: /purchase order/i });
    await expect(form).toBeVisible();
    await expect(form).toContainText('assistant filled this in');
    expect(await prisma.purchaseOrder.count()).toBe(0);
    const pending = await prisma.pendingAction.findFirstOrThrow({ where: { toolName: 'create_purchase_order' } });
    expect(pending.origin).toBe('ARTIFACT');
    expect(JSON.stringify(pending.proposedInput)).not.toMatch(/rate/i);
  });

  test('a diagram renders as a picture inside the sandbox; an SOP has no reads', async ({ page }) => {
    await seed();
    await login(page, OWNER);
    await say(page, 'draw how we receive material');
    const frame = page.frameLocator('iframe[title="How we receive material"]');
    await expect(frame.locator('#app svg')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-vijaya-footer]')).toContainText('No data read yet');
    const png = await fetchFile(page, 'Picture');
    expect(readFileSync(png.path).subarray(1, 4).toString()).toBe('PNG');
    // a document with no table cannot be Excel or CSV, and says so
    await toolbar(page).getByRole('button', { name: 'Download' }).click();
    await expect(page.getByRole('menuitem', { name: /Excel/ })).toHaveAttribute('data-disabled', '');
    await expect(page.getByRole('menuitem', { name: /Excel/ })).toContainText('there is no table in this');
  });

  test('a page (what-if) reads through the same tools; a page cannot be downloaded as Word', async ({ page }) => {
    await seed();
    await login(page, OWNER);
    await say(page, 'make me a what-if page for the copper rate');
    await expect(page.getByRole('region', { name: /If the copper rate changes, version 1/ })).toBeVisible();
    await expect(page.locator('[data-vijaya-footer]')).toContainText('estimate_job_cost');
    await toolbar(page).getByRole('button', { name: 'Download' }).click();
    await expect(page.getByRole('menuitem', { name: 'Word' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'PDF' })).toBeVisible();
  });
});

test.describe('changing, saving, restoring, sharing', () => {
  test('edit is a new version; restore makes another new one; earlier versions stay; Save keeps it under Saved', async ({ page, isMobile }) => {
    await seed();
    await login(page, OWNER);
    await say(page, 'make a below minimum report');
    await expect(page.getByRole('region', { name: 'Below minimum, version 1' })).toBeVisible();
    // on a phone the report covers the chat; closing it keeps it as the one being talked about
    if (isMobile) await page.getByRole('button', { name: 'Back to chat' }).click();
    await say(page, 'add a supplier column');
    await expect(page.getByRole('region', { name: 'Below minimum, version 2' }).last()).toBeVisible();
    await expect(toolbar(page).getByRole('button', { name: /Version 2/ })).toBeVisible();
    await toolbar(page).getByRole('button', { name: /Version 2/ }).click();
    await expect(page.getByRole('menuitem', { name: /v1/ })).toBeVisible();
    await page.getByRole('menuitem', { name: /v1/ }).click();
    await expect(toolbar(page).getByRole('button', { name: /Version 3/ })).toBeVisible();
    const versions = await prisma.artifactVersion.findMany({ orderBy: { n: 'asc' } });
    expect(versions.map((v) => [v.n, v.madeBy])).toEqual([[1, 'AGENT'], [2, 'AGENT'], [3, 'RESTORE']]);
    expect(versions[2]!.source).toBe(versions[0]!.source);
    // a version is never edited: the database refuses it
    await expect(prisma.$executeRaw`UPDATE artifact_versions SET source = 'x'`).rejects.toThrow();
    await toolbar(page).getByRole('button', { name: 'Save' }).click();
    await expect(toolbar(page).getByRole('button', { name: 'Saved' })).toBeVisible();
    if (isMobile) await page.getByRole('button', { name: 'Back to chat' }).click();
    await page.getByRole('button', { name: /^Saved/ }).first().click();
    await expect(page.getByRole('menuitem', { name: /Below minimum/ })).toBeVisible();
  });

  test('a change whose text does not match is refused, not reported as done; a build that never passes the checks says so', async ({ page }) => {
    await seed();
    await login(page, OWNER);
    await say(page, 'make a below minimum report');
    await say(page, 'edit nothing matches');
    await expect(page.getByText('That did not work.')).toBeVisible();
    expect(await prisma.artifactVersion.count()).toBe(1);
    await say(page, 'an impossible report please');
    await expect(page.getByText('I could not build that one. Here is the nearest table.')).toBeVisible();
    expect(await prisma.artifact.count()).toBe(1);
  });

  test('a build that needs a repair is repaired by the checker\'s own words, and only the good one is kept', async ({ page }) => {
    await seed();
    await login(page, OWNER);
    await say(page, 'a hostile report please');
    await expect(page.getByRole('region', { name: 'Below minimum, version 1' })).toBeVisible();
    expect(await prisma.artifactVersion.count()).toBe(1);
    expect((await prisma.artifactVersion.findFirstOrThrow()).source).not.toContain('₹5,000');
  });
});

test('the report and the saved-reports menu pass the accessibility scan in light and dark', async ({ page }) => {
  await seed();
  await login(page, OWNER);
  await say(page, 'make a below minimum report');
  await expect(panel(page)).toBeVisible();
  await page.frameLocator('iframe[title="Below minimum"]').locator('#app').getByText('Ferrite Core E-30').waitFor();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  }
});

void addPo; void addGrn;
