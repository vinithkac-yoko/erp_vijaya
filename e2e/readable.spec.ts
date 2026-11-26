import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { prisma, resetData } from './db';
import { login, settle } from './helpers';
import { OWNER } from './users';

test.beforeEach(async () => { await resetData(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 90_000 });

const say = async (page: Page, text: string) => {
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Type a message').fill(text);
  await page.getByLabel('Type a message').press('Enter');
};

test.describe('the assistant\'s words are readable', () => {
  test('bold, a table and a list are drawn, and no stars, bars or dashes are left on the screen', async ({ page }) => {
    await login(page, OWNER);
    await say(page, 'show me the markdown sample');
    const reply = page.getByText('There are none.').locator('xpath=ancestor::div[contains(@class,"border-l-copper")][1]');
    await expect(reply).toBeVisible({ timeout: 30_000 });
    // bold is bold, not **
    await expect(reply.locator('strong', { hasText: 'Open jobs:' })).toBeVisible();
    // the table is a real table with its numbers set to the right
    const table = reply.getByRole('table');
    await expect(table.getByRole('columnheader')).toHaveText(['Material', 'Unit', 'On hand', 'Minimum']);
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table.getByRole('cell', { name: 'AGNI ROD' })).toBeVisible();
    // the list is a list
    await expect(reply.getByRole('listitem')).toHaveText(['first thing', 'second thing']);
    await expect(reply.locator('em', { hasText: 'owner' })).toBeVisible();
    await expect(reply.locator('code', { hasText: 'ready' })).toBeVisible();
    // none of the marks is left as text
    const shown = await reply.innerText();
    expect(shown).not.toMatch(/\*\*|\|---|^\s*\|/m);
    expect(shown).not.toContain('`');
  });

  test('the drawn answer passes the accessibility scan in light and dark', async ({ page }) => {
    await login(page, OWNER);
    await say(page, 'show me the markdown sample');
    const reply = page.getByText('There are none.').locator('xpath=ancestor::div[contains(@class,"border-l-copper")][1]');
    await expect(reply.getByRole('table')).toBeVisible({ timeout: 30_000 });
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page);
      const r = await new AxeBuilder({ page }).include('div.border-l-copper').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`), theme).toEqual([]);
    }
  });
});
