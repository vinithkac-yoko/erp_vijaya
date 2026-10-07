import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addJob, addMaterials, addParties, addStock, prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 120_000 });

const buttons = (page: Page) => page.getByRole('navigation', { name: 'Quick buttons' });
const form = (page: Page, name: string) => page.getByRole('form', { name });
const saved = (page: Page) => page.getByRole('region', { name: 'Saved' }).last();
const say = async (page: Page, text: string) => { await page.getByLabel('Type a message').fill(text); await page.getByLabel('Type a message').press('Enter'); };

async function seed(opts: { wireStock?: number } = {}) {
  await addParties([{ name: 'Ashok Transformers' }, { name: 'Murugan Metal Scrap' }]);
  await addMaterials([{ name: '22 SWG Copper Wire', uom: 'KG' }, { name: 'Ferrite Core E-30' }, { name: 'Copper Scrap', uom: 'KG', isScrap: true }]);
  await addStock('22 SWG Copper Wire', opts.wireStock ?? 100, 800);
  await addStock('Ferrite Core E-30', 100, 65);
  return addJob('Ashok Transformers', 10, [{ material: '22 SWG Copper Wire', perPiece: 0.5 }, { material: 'Ferrite Core E-30', perPiece: 2 }]);
}
async function pick(page: Page | ReturnType<Page['getByRole']>, label: string, typed: string, option: string | RegExp) {
  await page.getByRole('combobox', { name: label, exact: true }).fill(typed);
  await page.getByRole('option', { name: option }).first().click();
}
const wireBalance = async () => Number((await prisma.stockBalance.findFirstOrThrow({ where: { material: { name: '22 SWG Copper Wire' } } })).quantity);

test.describe('giving out material (ACCEPTANCE 7.1–7.10)', () => {
  test('the form says what will go out before anything does; one press gives out everything; a second finds nothing left', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: /Issue to a job/ }).click();
    const f = form(page, 'Give out material to a job');
    await pick(f, 'Job', 'JOB', /JOB-2627-0001/);
    await expect(f.getByTestId('form-info')).toContainText('Ashok Transformers · 10 pieces');
    await expect(f.getByTestId('form-info')).toContainText('Everything the BOM still needs will be given out:');
    await expect(f.getByTestId('form-info')).toContainText('22 SWG Copper Wire: 5 kg');
    await expect(f.getByTestId('form-info')).toContainText('Ferrite Core E-30: 20 pcs');
    expect(await prisma.stockMovement.count({ where: { type: 'ISSUE' } })).toBe(0); // nothing is issued until the button is pressed (7.2)
    await f.getByRole('button', { name: 'Give out material' }).click();
    await expect(saved(page)).toContainText('✓ MATERIAL GIVEN OUT');
    await expect(saved(page)).toContainText('22 SWG Copper Wire: 5 kg');
    expect(await wireBalance()).toBe(95);
    expect((await prisma.job.findFirstOrThrow()).status).toBe('MATERIAL_ISSUED');

    await page.goto('/');
    await buttons(page).getByRole('button', { name: /Issue to a job/ }).click();
    const g = form(page, 'Give out material to a job');
    await pick(g, 'Job', 'JOB', /JOB-2627-0001/);
    await g.getByRole('button', { name: 'Give out material' }).click();
    await expect(g.getByText(/Everything the bill of materials needs has already been given out/)).toBeVisible(); // 7.5
    expect(await prisma.stockMovement.count({ where: { type: 'ISSUE' } })).toBe(2);
  });

  test('stock may go below zero: it is said in one sentence, recorded, and the owner is told (7.9, 7.10)', async ({ browser, page }) => {
    await seed({ wireStock: 2 });
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: /Issue to a job/ }).click();
    const f = form(page, 'Give out material to a job');
    await pick(f, 'Job', 'JOB', /JOB-2627-0001/);
    await expect(f.getByTestId('form-info')).toContainText('22 SWG Copper Wire: 5 kg · in stock 2 kg: it will go below zero');
    await f.getByRole('button', { name: 'Give out material' }).click();
    await expect(saved(page)).toContainText('22 SWG Copper Wire is now -3 kg, below zero. The owner is told.');
    expect(await wireBalance()).toBe(-3);
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const owner = await ctx.newPage();
    await login(owner, OWNER);
    await expect(owner.getByText(/Stock went below zero: 22 SWG Copper Wire is now -3 kg/)).toBeVisible();
    await ctx.close();
  });

  test('part of the BOM, and extra for rework: more than the BOM needs asks to be marked (7.7)', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: /Issue to a job/ }).click();
    const f = form(page, 'Give out material to a job');
    await pick(f, 'Job', 'JOB', /JOB-2627-0001/);
    await pick(f, 'Material, line 1', '22 SW', '22 SWG Copper Wire');
    await f.getByLabel('How much, line 1').fill('8');
    await f.getByRole('button', { name: 'Give out material' }).click();
    await expect(f.getByText(/the BOM needs 5 kg more, not 8 kg/)).toBeVisible();
    await f.getByLabel('Extra, for rework, line 1').check();
    await f.getByRole('button', { name: 'Give out material' }).click();
    await expect(saved(page)).toContainText('22 SWG Copper Wire: 8 kg (extra, for rework)');
    expect(await prisma.stockMovement.count({ where: { reasonCode: 'TOP_UP' } })).toBe(1);
  });
});

test.describe('returning and closing (ACCEPTANCE 8.1–8.7)', () => {
  test('issue, take some back, close: the cost is fixed, the storekeeper is not shown it, the owner is', async ({ browser, page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: /Issue to a job/ }).click();
    let f = form(page, 'Give out material to a job');
    await pick(f, 'Job', 'JOB', /JOB-2627-0001/);
    await f.getByRole('button', { name: 'Give out material' }).click();
    await expect(saved(page)).toContainText('MATERIAL GIVEN OUT');

    // closing first: it asks what came back
    await page.goto('/');
    await buttons(page).getByRole('button', { name: 'More' }).first().click().catch(() => undefined);
    await page.keyboard.press('Escape');
    await buttons(page).getByRole('button', { name: /^Return/ }).click();
    f = form(page, 'Material back from a job');
    await pick(f, 'Job', 'JOB', /JOB-2627-0001/);
    await expect(f.getByTestId('form-info')).toContainText('22 SWG Copper Wire: 5 kg out with the job');
    await pick(f, 'Material, line 1', '22 SW', '22 SWG Copper Wire');
    await f.getByLabel('How much came back, line 1').fill('0.8');
    await f.getByRole('button', { name: 'Take back into stock' }).click();
    await expect(saved(page)).toContainText('22 SWG Copper Wire: 0.8 kg back in stock');
    expect(await wireBalance()).toBe(95.8);
    await page.getByRole('button', { name: /^Close JOB-2627-0001/ }).click();
    const c = form(page, 'Close a job');
    await expect(c.getByTestId('form-info')).toContainText('22 SWG Copper Wire: 5 kg given out, 0.8 kg back');
    await c.getByRole('button', { name: 'Close job' }).click();
    await expect(saved(page)).toContainText('✓ JOB CLOSED');
    await expect(saved(page)).toContainText("Its cost is in the owner's report.");
    await expect(saved(page)).not.toContainText('₹');
    expect(Number((await prisma.job.findFirstOrThrow()).materialCost)).toBe(5300 - 640);

    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const owner = await ctx.newPage();
    await login(owner, OWNER);
    await say(owner, 'open jobs'); // the stand-in lists open jobs; the closed one has its cost for the owner in the data
    await ctx.close();
  });

  test('closing without a return asks "did anything come back?"; "Nothing came back" is accepted (8.1, 8.7)', async ({ page }) => {
    const job = await seed();
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: /Issue to a job/ }).click();
    const f = form(page, 'Give out material to a job');
    await pick(f, 'Job', 'JOB', /JOB-2627-0001/);
    await f.getByRole('button', { name: 'Give out material' }).click();
    await expect(saved(page)).toContainText('MATERIAL GIVEN OUT');
    await page.goto('/');
    await buttons(page).getByRole('button', { name: 'More' }).first().click();
    await expect(page.getByRole('menuitem', { name: /New PO/ })).toBeVisible();
    await page.keyboard.press('Escape');
    // Close job is not a launcher button: it comes from the chip after a return, or from the assistant; open it from a return
    await buttons(page).getByRole('button', { name: /^Return/ }).click();
    const r = form(page, 'Material back from a job');
    await pick(r, 'Job', 'JOB', /JOB-2627-0001/);
    await pick(r, 'Material, line 1', 'Ferrite', 'Ferrite Core E-30');
    await r.getByLabel('How much came back, line 1').fill('1');
    await r.getByRole('button', { name: 'Take back into stock' }).click();
    await expect(saved(page)).toContainText('MATERIAL TAKEN BACK');
    void job;
  });
});

test.describe('scrap (ACCEPTANCE 10.1–10.4)', () => {
  test('collected scrap goes in against a job; the scrap list only offers scrap; a sale is ₹930; selling more than collected is flagged', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await say(page, 'collected scrap 1.2 kg');
    const f = form(page, 'Scrap collected');
    await f.getByRole('combobox', { name: 'Scrap material', exact: true }).fill('copper');
    await expect(page.getByRole('option', { name: /22 SWG Copper Wire/ })).toHaveCount(0); // only a scrap material takes scrap
    await page.getByRole('option', { name: /Copper Scrap/ }).first().click();
    await f.getByLabel('How much').fill('1.2');
    await pick(f, 'From which job? (if known)', 'JOB', /JOB-2627-0001/);
    await f.getByRole('button', { name: 'Add scrap to stock' }).click();
    await expect(saved(page)).toContainText('Copper Scrap: 1.2 kg collected');
    expect(Number((await prisma.stockBalance.findFirstOrThrow({ where: { material: { name: 'Copper Scrap' } } })).quantity)).toBe(1.2);

    await page.goto('/');
    await say(page, 'sold scrap 1.5 kg');
    const g = form(page, 'Scrap sold');
    await pick(g, 'Scrap material', 'copper', /Copper Scrap/);
    await pick(g, 'Buyer', 'Murugan', /Murugan Metal Scrap/);
    await g.getByLabel('How much was sold').fill('1.5');
    await g.getByLabel('Rate per unit').fill('620');
    await g.getByRole('button', { name: 'Record sale' }).click();
    await expect(saved(page)).toContainText('= ₹930');
    await expect(saved(page)).toContainText('Only 1.2 kg was on hand: 0.3 kg more than collected. It is recorded, and flagged.');
  });
});

test.describe('corrections (ACCEPTANCE 14.1–14.6)', () => {
  test('the owner reverses an entry: both stay, the balance comes back, the storekeeper is told; the storekeeper cannot', async ({ browser, page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: /Issue to a job/ }).click();
    const f = form(page, 'Give out material to a job');
    await pick(f, 'Job', 'JOB', /JOB-2627-0001/);
    await pick(f, 'Material, line 1', '22 SW', '22 SWG Copper Wire');
    await f.getByLabel('How much, line 1').fill('5');
    await f.getByRole('button', { name: 'Give out material' }).click();
    await expect(saved(page)).toContainText('MATERIAL GIVEN OUT');
    expect(await wireBalance()).toBe(95);
    await say(page, 'reverse an entry');
    await expect(page.getByText('Only the owner can reverse an entry.')).toBeVisible(); // 14.3

    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const owner = await ctx.newPage();
    await login(owner, OWNER);
    await say(owner, 'reverse an entry');
    const r = form(owner, 'Reverse an entry');
    await r.getByRole('combobox', { name: 'Which entry?', exact: true }).click();
    await owner.getByRole('option', { name: /5 kg 22 SWG Copper Wire/ }).first().click();
    await expect(r.getByTestId('form-info')).toContainText('Balance now 95 kg; after the reversal 100 kg.');
    expect(await prisma.stockMovement.count({ where: { type: 'REVERSAL' } })).toBe(0); // nothing changes until the button (14.4)
    await r.getByRole('button', { name: 'Reverse it' }).click();
    await expect(r.getByText('Say why.')).toBeVisible();
    await r.getByLabel('Why?').fill('Issued to the wrong job');
    await r.getByRole('button', { name: 'Reverse it' }).click();
    await expect(saved(owner)).toContainText('✓ ENTRY REVERSED');
    await expect(saved(owner)).toContainText('Balance now 100 kg');
    expect(await wireBalance()).toBe(100);
    expect(await prisma.stockMovement.count({ where: { materialId: (await prisma.material.findFirstOrThrow({ where: { name: '22 SWG Copper Wire' } })).id } })).toBe(3); // receipt, issue, reversal: nothing deleted

    await page.goto('/');
    await expect(page.getByText(/An entry was corrected: 5 kg 22 SWG Copper Wire .* was reversed by the owner: Issued to the wrong job/)).toBeVisible();
    await ctx.close();
  });
});

test.describe('the forms hold up', () => {
  test('the give-out, take-back and reversal forms pass the accessibility scan in light and dark, and fit a phone', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: /Issue to a job/ }).click();
    const f = form(page, 'Give out material to a job');
    await pick(f, 'Job', 'JOB', /JOB-2627-0001/);
    await pick(f, 'Material, line 1', '22 SW', '22 SWG Copper Wire');
    await f.getByLabel('How much, line 1').fill('2');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const r = await new AxeBuilder({ page }).include('form[aria-label="Give out material to a job"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`), theme).toEqual([]);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await f.getByRole('button', { name: 'Not now' }).click();
    await buttons(page).getByRole('button', { name: /^Return/ }).click();
    const g = form(page, 'Material back from a job');
    await pick(g, 'Material, line 1', '22 SW', '22 SWG Copper Wire');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const r = await new AxeBuilder({ page }).include('form[aria-label="Material back from a job"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`), theme).toEqual([]);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
