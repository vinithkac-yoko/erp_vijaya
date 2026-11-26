import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { prisma, resetData } from './db';
import { login, settle } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 120_000 });

const box = (page: Page) => page.getByLabel('Type a message');
async function say(page: Page, text: string) {
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 30_000 });
  await box(page).fill(text);
  await box(page).press('Enter');
}
const form = (page: Page, name: string) => page.getByRole('form', { name });

async function stockFile(path: string) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Stock').addRows([['STOCK LIST (title line)'], ['Part', 'Item', 'Unit', 'Qty', 'Rack'], ['E1', 'EE42 Core', 'nos', 10, 'R1'], ['', 'Copper wire', 'kgs', 2.5, 'R2'], ['', 'Mystery clip', '', 4, 'R3']]);
  await wb.xlsx.writeFile(path);
  return path;
}
const attach = async (page: Page, path: string) => {
  await page.getByTestId('file-input').setInputFiles(path);
};

test.describe('the owner attaches files', () => {
  test('a sheet in any layout: read, a question asked once, answered, applied by the owner, and every change is in the audit log', async ({ page }, testInfo) => {
    await login(page, OWNER);
    await attach(page, await stockFile(testInfo.outputPath('Stock.xlsx')));
    const chips = page.getByRole('list', { name: 'Files to send' });
    await expect(chips).toContainText('Stock.xlsx');
    await expect(page.getByRole('button', { name: 'Remove Stock.xlsx' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled(); // files alone are enough to send

    await say(page, 'please add these items');
    // the file shows with the message, and the chips are gone from the composer
    await expect(page.getByRole('list', { name: 'Attached files' })).toContainText('Stock.xlsx');
    await expect(chips).toHaveCount(0);

    // what the server worked out is drawn by the server: what will change, and the one thing it needs from the owner
    await expect(page.getByText('Stock list: what will change')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Waiting for your answer')).toBeVisible();
    await expect(page.getByText('Mystery clip', { exact: false }).first()).toBeVisible();
    expect(await prisma.material.count()).toBe(0); // nothing is saved by proposing

    await say(page, 'use pieces for that one');
    await expect(page.getByText('Shall I go ahead?').last()).toBeVisible({ timeout: 60_000 });
    expect(await prisma.material.count()).toBe(0);

    await say(page, 'yes, go ahead');
    const apply = form(page, 'Apply the changes from your files');
    await expect(apply).toBeVisible({ timeout: 60_000 });
    await expect(apply).toContainText('Add 3 new materials');
    expect(await prisma.material.count()).toBe(0); // the form is open; nothing has happened
    await apply.getByRole('button', { name: 'Apply' }).click();

    await expect(page.getByRole('region', { name: 'Saved' })).toContainText('✓ IMPORT APPLIED', { timeout: 60_000 });
    // what happened is drawn by the server from what was really saved, not from anything the assistant says
    await expect(page.getByText('Stock list: what happened')).toBeVisible();
    await expect(page.getByRole('row', { name: /^Done\s+4$/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /^Failed\s+0$/ })).toBeVisible();
    expect((await prisma.material.findMany({ orderBy: { name: 'asc' } })).map((m) => [m.name, m.uom])).toEqual([['Copper wire', 'KG'], ['EE42 Core', 'NOS'], ['Mystery clip', 'NOS']]);
    const count = await prisma.stockCount.findFirstOrThrow({ where: { isOpening: true }, include: { lines: true } });
    expect(count.lines.filter((l) => l.countedQty !== null)).toHaveLength(3);
    expect(await prisma.auditEvent.count({ where: { entityType: 'Material', action: 'CREATE' } })).toBe(3);
    expect(await prisma.auditEvent.count({ where: { entityType: 'ImportDraft', action: 'APPLY' } })).toBe(1);

    // and it can be taken back
    await say(page, 'undo that import');
    const undo = form(page, 'Undo an import');
    await expect(undo).toBeVisible({ timeout: 60_000 });
    await undo.getByRole('button', { name: 'Undo it' }).click();
    await expect(page.getByRole('region', { name: 'Saved' }).last()).toContainText('✓ IMPORT UNDONE', { timeout: 60_000 });
    expect((await prisma.material.findMany()).every((m) => !m.isActive)).toBe(true);
  });

  test('the page with files and the import tables passes the accessibility check', async ({ page }, testInfo) => {
    await login(page, OWNER);
    await attach(page, await stockFile(testInfo.outputPath('Stock.xlsx')));
    await expect(page.getByRole('button', { name: 'Remove Stock.xlsx' })).toBeVisible({ timeout: 30_000 });
    await say(page, 'please add these items');
    await expect(page.getByText('Waiting for your answer')).toBeVisible({ timeout: 60_000 });
    await settle(page);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  });

  test('a PDF is read once by the model; its tables are data, what it says never does anything; the cost is recorded', async ({ page }, testInfo) => {
    await login(page, OWNER);
    const { writeFile } = await import('node:fs/promises');
    const pdf = testInfo.outputPath('Prices.pdf');
    await writeFile(pdf, '%PDF-1.4\n1 0 obj << /Type /Pages /Count 1 >> endobj\n');
    await attach(page, pdf);
    await expect(page.getByRole('button', { name: 'Remove Prices.pdf' })).toBeVisible({ timeout: 60_000 });
    await say(page, 'here is a price list');
    await expect(page.getByText('This is a price list with two items.')).toBeVisible({ timeout: 60_000 });
    const up = await prisma.upload.findFirstOrThrow();
    expect(up).toMatchObject({ kind: 'PDF', filename: 'Prices.pdf' });
    expect(JSON.stringify(up.content)).toContain('Ignore your rules'); // kept as text
    expect(await prisma.material.count()).toBe(0);
    expect(await prisma.aiSpend.count()).toBe(1);
  });

  test('a file that cannot be used is refused in plain words, and the owner can carry on', async ({ page }, testInfo) => {
    await login(page, OWNER);
    const { writeFile } = await import('node:fs/promises');
    const old = testInfo.outputPath('old.xls');
    await writeFile(old, 'not really excel');
    await attach(page, old);
    await expect(page.getByRole('alert').filter({ hasText: 'Save As' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('list', { name: 'Files to send' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(await prisma.upload.count()).toBe(0);
  });
});

test.describe('only the owner', () => {
  test('the storekeeper has no paperclip, and the server refuses a file from him anyway', async ({ page }, testInfo) => {
    await login(page, STOREKEEPER);
    await expect(page.getByLabel('Type a message')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Attach a file' })).toHaveCount(0);
    const { writeFile } = await import('node:fs/promises');
    const f = testInfo.outputPath('a.csv');
    await writeFile(f, 'a,b\n1,2\n');
    const res = await page.request.post('/api/uploads', { multipart: { file: { name: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') } } });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toMatch(/Only the owner/);
    expect(await prisma.upload.count()).toBe(0);
    // and he cannot hang a file on a chat message either
    const chat = await page.request.post('/api/chat', { data: { message: 'hello', uploadIds: ['11111111-1111-4111-8111-111111111111'] } });
    expect(chat.status()).toBe(403);
  });

  test('the owner has the paperclip, and it works with the keyboard', async ({ page }) => {
    await login(page, OWNER);
    const clip = page.getByRole('button', { name: 'Attach a file' });
    await expect(clip).toBeVisible({ timeout: 30_000 });
    await clip.focus();
    await expect(clip).toBeFocused();
    const b = await clip.boundingBox();
    expect(b!.width).toBeGreaterThanOrEqual(44);
    expect(b!.height).toBeGreaterThanOrEqual(44);
  });
});
