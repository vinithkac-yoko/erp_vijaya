import { expect, type Page } from '@playwright/test';

export async function login(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(who.email);
  await page.getByLabel('Password', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('navigation', { name: 'Quick buttons' })).toBeVisible();
  await page.locator('body[data-ready="true"]').waitFor({ state: 'attached' });
}

/** After a theme switch the buttons fade to their new colours; an accessibility scan taken in the middle of the fade measures a colour that is on screen for a moment only. */
export async function settle(page: Page) {
  await page.waitForFunction(() => document.getAnimations().length === 0, undefined, { timeout: 5_000 }).catch(() => undefined);
}
