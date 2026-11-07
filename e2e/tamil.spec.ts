import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addDecisions, prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); await addDecisions(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 90_000 });

const say = async (page: Page, text: string) => {
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Type a message').fill(text);
  await page.getByLabel('Type a message').press('Enter');
};

// the test assistant's translator puts "தமிழில்:" in front of each text and keeps the text, so numbers and names survive
test.describe('Tamil on request', () => {
  for (const [who, user] of [['storekeeper', STOREKEEPER], ['owner', OWNER]] as const) {
    test(`${who}: an answer is shown in Tamil when asked and goes back to English`, async ({ page }) => {
      await login(page, user);
      await say(page, 'how much copper do we have');
      const reply = page.getByText('There is no 22 SWG Copper Wire in the list yet.');
      await expect(reply).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Show in Tamil' }).last().click();
      const tamil = page.getByText(/^தமிழில்: There is no 22 SWG Copper Wire/);
      await expect(tamil).toBeVisible();
      await expect(tamil).toHaveAttribute('lang', 'ta');
      await page.getByRole('button', { name: 'Show in English' }).click();
      await expect(reply).toBeVisible();
      expect(await prisma.translation.count()).toBeGreaterThan(0);
    });
  }

  test('the opening card can be put in Tamil, and the page stays accessible', async ({ page }) => {
    await login(page, OWNER);
    const card = page.getByRole('region', { name: 'Welcome' });
    await card.getByRole('button', { name: 'Show in Tamil' }).click();
    await expect(card.locator('[lang="ta"]').first()).toBeVisible();
    await expect(card).toContainText('தமிழில்:');
    const axe = await new AxeBuilder({ page }).include('section[aria-label="Welcome"]').analyze();
    expect(axe.violations).toEqual([]);
  });

  test('a question for the owner can be read in Tamil; the saved answer is still the English choice', async ({ page }) => {
    await login(page, OWNER);
    await page.getByRole('button', { name: /^Questions for you/ }).click();
    const panel = page.getByTestId('decisions-panel');
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { expanded: false }).first().click();
    await panel.getByRole('button', { name: 'Show in Tamil' }).click();
    await expect(panel.getByRole('radio').first().locator('xpath=following-sibling::span')).toContainText('தமிழில்:');
    await panel.getByRole('radio').first().check();
    await panel.getByRole('button', { name: 'Save my answer' }).click();
    await expect(panel.getByText('Saved. Thank you.')).toBeVisible();
    const row = await prisma.decision.findFirstOrThrow({ where: { status: 'ANSWERED' } });
    expect(row.answerChoice).not.toContain('தமிழில்');
  });
});
