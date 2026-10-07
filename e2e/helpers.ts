import { expect, type Page } from '@playwright/test';

export async function login(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(who.email);
  await page.getByLabel('Password', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('navigation', { name: 'Quick buttons' })).toBeVisible();
  await page.locator('body[data-ready="true"]').waitFor({ state: 'attached' });
}
