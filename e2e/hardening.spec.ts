import { expect, test, type Page } from '@playwright/test';
import { prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); await prisma.user.updateMany({ data: { lastActiveAt: null, sessionEpoch: 0 } }); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 240_000 });

const say = async (page: Page, text: string) => {
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Type a message').fill(text);
  await page.getByLabel('Type a message').press('Enter');
};

test.describe('the app on a phone (PWA)', () => {
  test('the manifest, icons, service worker and offline page are there without a login, and carry no data', async ({ request }) => {
    const m = await request.get('/manifest.webmanifest');
    expect(m.status()).toBe(200);
    const manifest = await m.json();
    expect(manifest).toMatchObject({ name: 'Vijaya Stores', display: 'standalone', start_url: '/', theme_color: '#1B2A38' });
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const i of manifest.icons as { src: string }[]) {
      const r = await request.get(i.src);
      expect(r.status()).toBe(200);
      expect(r.headers()['content-type']).toContain('image/png');
    }
    const sw = await request.get('/sw.js');
    expect(sw.status()).toBe(200);
    const code = await sw.text();
    expect(code).toContain("startsWith('/api/')");                 // an API answer is never kept
    expect(code).not.toMatch(/caches\.put\(.*(document|navigate)/); // and neither is a page
    const off = await request.get('/offline.html');
    expect(off.status()).toBe(200);
    expect(await off.text()).toContain('No connection');
  });
});

test.describe('how long a login lasts (SAFETY T12)', () => {
  test('the storekeeper is logged out after 12 hours without use; the owner stays in for 30 days', async ({ page, browser }) => {
    await login(page, STOREKEEPER);
    await prisma.user.updateMany({ where: { role: 'STOREKEEPER' }, data: { lastActiveAt: new Date(Date.now() - 13 * 3_600_000) } });
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);

    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const owner = await ctx.newPage();
    await login(owner, OWNER);
    await prisma.user.updateMany({ where: { role: 'OWNER' }, data: { lastActiveAt: new Date(Date.now() - 29 * 24 * 3_600_000) } });
    await owner.goto('/');
    await expect(owner).toHaveURL(/\/$/);
    await prisma.user.updateMany({ where: { role: 'OWNER' }, data: { lastActiveAt: new Date(Date.now() - 31 * 24 * 3_600_000) } });
    await owner.goto('/');
    await expect(owner).toHaveURL(/\/login$/);
    await ctx.close();
  });

  test('a new password ends every session the person already has', async ({ page }) => {
    await login(page, STOREKEEPER);
    await page.goto('/');
    await expect(page).toHaveURL(/\/$/);
    await prisma.user.updateMany({ where: { role: 'STOREKEEPER' }, data: { sessionEpoch: { increment: 1 } } }); // what reset_user_password does
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('the demo copy (DEMO_MODE) — start the demo again', () => {
  test('the owner asks in the chat; a form says it cannot be undone; one press wipes and fills in a fresh month through the real tools', async ({ page }) => {
    await login(page, OWNER);
    await say(page, 'start the demo again');
    const form = page.getByRole('form', { name: 'Start the demo again' });
    await expect(form).toBeVisible();
    await expect(form).toContainText('cannot be undone');
    await form.getByLabel('Yes, wipe the demo data and start again').check();
    await form.getByRole('button', { name: 'Wipe and start again' }).click();
    await expect(page.getByRole('region', { name: 'Saved' }).last()).toContainText('DEMO STARTED AGAIN', { timeout: 120_000 });

    expect(await prisma.job.count()).toBe(12);
    expect(await prisma.job.count({ where: { type: 'SAMPLE' } })).toBe(1);
    expect(await prisma.customerPo.count()).toBe(1);
    expect(await prisma.job.count({ where: { customerPo: { number: 'SRSW-OP-44' } } })).toBe(3);
    expect(await prisma.material.count()).toBe(9);
    expect(await prisma.purchaseOrder.count({ where: { status: 'PENDING_APPROVAL' } })).toBe(1);              // the one above the limit
    expect(await prisma.goodsReceiptLine.count({ where: { rejectedQty: { gt: 0 } } })).toBe(1);               // one rejection
    expect(await prisma.stockCount.count({ where: { isOpening: false, status: 'APPROVED' } })).toBe(1);
    const leak = await prisma.$queryRaw<{ unexplained_count: bigint }[]>`SELECT unexplained_count FROM v_material_leak WHERE unexplained_count > 0`;
    expect(leak.length).toBeGreaterThanOrEqual(2);                                                            // the leak report has a story
    expect(await prisma.$queryRaw`SELECT * FROM v_balance_integrity`).toEqual([]);                            // and the books still balance
    expect(await prisma.user.count()).toBeGreaterThanOrEqual(2);                                              // logins stay
    const first = await prisma.stockMovement.count();

    // again: the same month, not a second one on top
    await say(page, 'start the demo again');
    const again = page.getByRole('form', { name: 'Start the demo again' }).last();
    await again.getByLabel('Yes, wipe the demo data and start again').check();
    await again.getByRole('button', { name: 'Wipe and start again' }).click();
    // the first card is still on the screen, so wait for the second one: the new month is only built when it shows
    await expect(page.getByRole('region', { name: 'Saved' }).filter({ hasText: 'DEMO STARTED AGAIN' })).toHaveCount(2, { timeout: 120_000 });
    expect(await prisma.job.count()).toBe(12);
    expect(await prisma.stockMovement.count()).toBe(first);
    expect(await prisma.auditEvent.count({ where: { action: 'RESET' } })).toBe(1);   // the reset wiped the first one's trail; the newest is kept
  });

  test('the storekeeper cannot start it again, and the reset form is the owner\'s alone', async ({ page }) => {
    await login(page, STOREKEEPER);
    await say(page, 'start the demo again');
    await expect(page.getByText('Only the owner can start the demo again.')).toBeVisible();
    await expect(page.getByRole('form', { name: 'Start the demo again' })).toHaveCount(0);
  });
});
