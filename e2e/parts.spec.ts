import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMaterials, addParties, addPart, prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 90_000 });

const form = (page: Page, name: string) => page.getByRole('form', { name });
const saved = (page: Page) => page.getByRole('region', { name: 'Saved' }).last();
const say = async (page: Page, text: string) => {
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Type a message').fill(text);
  await page.getByLabel('Type a message').press('Enter');
};

async function seed() {
  await addParties([{ name: 'Medha Servo Drives' }]);
  await addMaterials([{ name: '22 SWG Copper Wire', uom: 'KG' }, { name: 'Ferrite Core E-30' }]);
  await addPart('Medha Servo Drives', '90305600201', 'TXFR L9 (EXT) FOR M628VCUPS', [{ material: '22 SWG Copper Wire', perPiece: 0.0184 }, { material: 'Ferrite Core E-30', perPiece: 2 }]);
}

test.describe('everything runs by part number (client paperwork, 2026-10-20)', () => {
  test('a new part: the form carries what the assistant worked out; saving it offers its BOM and a job', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await say(page, 'add the part');
    const f = form(page, 'Add a part');
    await expect(f).toBeVisible();
    await expect(f.getByLabel('Part number')).toHaveValue('90308200008');
    await expect(f.getByLabel('What it is')).toHaveValue('TXFR FOR M634VOC');
    await f.getByRole('button', { name: 'Add part' }).click();
    await expect(saved(page)).toContainText('✓ PART ADDED');
    await expect(saved(page)).toContainText('90308200008 · TXFR FOR M634VOC');
    await expect(page.getByRole('button', { name: 'Add its BOM' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create a job for it' })).toBeVisible();
    expect(await prisma.part.count()).toBe(2);
  });

  test('a job for a part: the customer comes from the part, and the BOM form starts from the part\'s usual materials', async ({ page }) => {
    await seed();
    await addPart('Medha Servo Drives', '90308200008', 'TXFR FOR M634VOC', [{ material: '22 SWG Copper Wire', perPiece: 0.02 }]);
    await login(page, STOREKEEPER);
    await say(page, 'new job for part 90308200008');
    const f = form(page, 'New job');
    await expect(f).toBeVisible();
    await expect(f.getByTestId('form-info')).toContainText('90308200008 · TXFR FOR M634VOC');
    await expect(f.getByText('Medha Servo Drives').first()).toBeVisible();
    await f.getByRole('button', { name: 'Create job' }).click();
    await expect(saved(page)).toContainText('✓ JOB CREATED');
    await expect(saved(page)).toContainText('Part 90308200008');
    await page.getByRole('button', { name: 'Add the BOM' }).click();
    const bom = form(page, 'Bill of materials');
    await expect(bom.getByTestId('form-info')).toContainText('usual materials for part 90308200008');
    await expect(bom.getByTestId('bom-total').first()).toContainText('8 kg');   // 0.02 kg a piece × 400 pieces
  });

  test('the customer\'s order lists parts: the owner has a rate box, the storekeeper does not; what is left to plan is told', async ({ browser, page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await say(page, 'record the medha po');
    const f = form(page, 'Record a customer PO');
    await expect(f).toBeVisible();
    await expect(f.getByTestId('part-lines')).toContainText('90305600201');
    await expect(f.getByLabel(/Rate for one piece/)).toHaveCount(0);
    await f.getByRole('button', { name: 'Save PO' }).click();
    await expect(saved(page)).toContainText('✓ CUSTOMER PO SAVED');
    await expect(saved(page)).toContainText('90305600201 · TXFR L9 (EXT) FOR M628VCUPS — 492 pieces');
    expect(await prisma.customerPoLine.count()).toBe(1);
    await say(page, 'what is left on the medha po');
    await expect(page.getByRole('table').last()).toContainText('492');
    // the owner's form has the rate box
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const him = await ctx.newPage();
    await login(him, OWNER);
    await say(him, 'record the medha po');
    await expect(form(him, 'Record a customer PO').getByLabel(/Rate for one piece/)).toBeVisible();
    await ctx.close();
  });

  test('the part forms pass the accessibility scan in light and dark', async ({ page }) => {
    await seed();
    await login(page, OWNER);
    await say(page, 'record the medha po');
    await expect(form(page, 'Record a customer PO')).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const r = await new AxeBuilder({ page }).include('[role="form"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    }
  });
});
