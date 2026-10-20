import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 90_000 });

// The browser's fake microphone plays a test tone; the test listener "hears" a Tamil-and-English sentence whatever it gets.
for (const [who, user] of [['storekeeper', STOREKEEPER], ['owner', OWNER]] as const) {
  test(`${who}: the microphone puts what was said in the box; nothing is sent until Send`, async ({ page }) => {
    await login(page, user);
    const box = page.getByLabel('Type a message');
    await expect(box).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Speak your message' }).click();
    await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(box).toHaveValue('copper wire evlo irukku, how much copper do we have', { timeout: 15_000 });
    // it is only text in the box: the person reads it, and sends it
    expect(await prisma.conversation.count()).toBe(0);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('There is no 22 SWG Copper Wire in the list yet.')).toBeVisible({ timeout: 30_000 });
  });
}

test('when nothing could be heard the person is told plainly and can type', async ({ page }) => {
  await login(page, STOREKEEPER);
  await page.route('**/api/speech/transcribe', (route) => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: "Didn't hear anything. Please try again." }) }));
  await page.getByRole('button', { name: 'Speak your message' }).click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.getByRole('alert').filter({ hasText: "Didn't hear anything" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel('Type a message')).toHaveValue('');
  await expect(page.getByLabel('Type a message')).toBeEnabled();
});

test('the microphone button is reachable by keyboard and passes the accessibility check', async ({ page }) => {
  await login(page, OWNER);
  const mic = page.getByRole('button', { name: 'Speak your message' });
  await expect(mic).toBeVisible({ timeout: 30_000 });
  await mic.focus();
  await expect(mic).toBeFocused();
  const axe = await new AxeBuilder({ page }).include('form').analyze();
  expect(axe.violations).toEqual([]);
  const box = await mic.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

test('a person who is not logged in cannot use the listener', async ({ request }) => {
  const res = await request.post('/api/speech/transcribe', { multipart: { audio: { name: 'a.webm', mimeType: 'audio/webm', buffer: Buffer.alloc(2000, 1) } } });
  expect(res.status()).toBe(401);
});
