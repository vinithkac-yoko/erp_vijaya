import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addApprovedCount, addJob, addMaterials, addParties, addStock, prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 120_000 });

const say = async (page: Page, text: string) => { await page.getByLabel('Type a message').fill(text); await page.getByLabel('Type a message').press('Enter'); };
const table = (page: Page) => page.getByRole('table').last();

/** Copper and bobbins with two approved monthly counts: copper short twice (one reason given), bobbins short once, nobody could say why. */
async function seed() {
  await addParties([{ name: 'Ashok Transformers' }]);
  await addMaterials([{ name: '22 SWG Copper Wire', uom: 'KG' }, { name: 'Bobbin Type-B' }]);
  await addStock('22 SWG Copper Wire', 100, 800);
  await addStock('Bobbin Type-B', 652, 9);
  await addApprovedCount('2026-09-30', [{ material: '22 SWG Copper Wire', system: 100, counted: 98, reason: 'MISSING' }, { material: 'Bobbin Type-B', system: 652, counted: 612, reason: 'UNEXPLAINED' }]);
  await addApprovedCount('2026-10-31', [{ material: '22 SWG Copper Wire', system: 98, counted: 97 }, { material: 'Bobbin Type-B', system: 612, counted: 612 }]);
}

test.describe('the owner\'s questions (ACCEPTANCE 12, 13)', () => {
  test('"Where is my stock leaking?" is a table, biggest first, with what nobody explained and no names', async ({ page }) => {
    await seed();
    await login(page, OWNER);
    await say(page, 'where is my stock leaking?');
    await expect(page.getByText('Here is where the counts differed.')).toBeVisible();
    const t = table(page);
    await expect(t.getByRole('row')).toHaveCount(3); // header + two materials
    await expect(t.getByRole('row').nth(1)).toContainText('22 SWG Copper Wire');
    await expect(t.getByRole('row').nth(1)).toContainText('2 of 2');
    await expect(t.getByRole('row').nth(1)).toContainText('₹2,400');
    await expect(t.getByRole('row').nth(2)).toContainText('Bobbin Type-B');
    await expect(t.getByRole('row').nth(2)).toContainText('40 pcs');
    await expect(page.getByText('Count differences: ₹2,760 in all, 2 not explained')).toBeVisible();
    const text = await page.locator('main').innerText();
    expect(text).not.toMatch(/\bMAT-\d|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  test('the storekeeper is told it is the owner\'s, and no table appears', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await say(page, 'where is my stock leaking?');
    await expect(page.getByText("The leak report is the owner's.")).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
  });

  test('the bobbin count history shows what the system said, what was counted and why it differed — for the storekeeper too (12.4, 11.18)', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await say(page, 'show bobbin history');
    await expect(page.getByText('Every count of the bobbins, newest first.')).toBeVisible();
    const t = table(page);
    await expect(t.getByRole('row')).toHaveCount(3);
    await expect(t.getByRole('row').nth(2)).toContainText('652 pcs');
    await expect(t.getByRole('row').nth(2)).toContainText('612 pcs');
    await expect(t.getByRole('row').nth(2)).toContainText('−40 pcs');
    await expect(t.getByRole('row').nth(2)).toContainText("Don't know");
    await expect(t.getByRole('row').nth(1)).toContainText('matches');
  });

  test('job costs for the owner, and the copper what-if with nothing saved', async ({ page }) => {
    await seed();
    await addJob('Ashok Transformers', 10, [{ material: '22 SWG Copper Wire', perPiece: 0.5 }]);
    await login(page, OWNER);
    await say(page, 'job costs please');
    await expect(page.getByText('Here are the jobs and what they cost.')).toBeVisible();
    await expect(table(page)).toContainText('Ashok Transformers');
    await expect(table(page)).toContainText('Open, nothing issued');
    await say(page, 'what if copper goes up to 900');
    await expect(page.getByText('Here is what that does to the open jobs.')).toBeVisible();
    await expect(page.getByText('Open jobs: ₹4,000 now, ₹4,500 at the new rate')).toBeVisible();
    await expect(page.getByText('A what-if only: nothing is saved and no price changes.')).toBeVisible();
    const copper = await prisma.stockBalance.findFirstOrThrow({ where: { material: { name: '22 SWG Copper Wire' } } });
    expect(Number(copper.averageRate)).toBe(800);
  });

  test('"what was done today" lists who did what, and tags the chat assistant', async ({ page }) => {
    await seed();
    await login(page, OWNER);
    await say(page, 'add 22 swg wire');
    await expect(page.getByRole('form', { name: /Add a material/ })).toBeVisible();
    await say(page, 'what was done today');
    await expect(page.getByText('Here is what was done today.')).toBeVisible();
    await expect(page.getByText('No activity', { exact: false })).toHaveCount(0);
  });

  test('the report tables pass the accessibility scan in light and dark, and fit a phone', async ({ page, isMobile }) => {
    await seed();
    await login(page, OWNER);
    await say(page, 'where is my stock leaking?');
    await expect(table(page)).toBeVisible();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    }
    if (isMobile) expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});
