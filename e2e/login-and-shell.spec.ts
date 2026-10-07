import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { OWNER, STOREKEEPER } from './users';
import { login } from './helpers';

test.describe('login', () => {
  test('a visitor who is not logged in is sent to the login page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
  });

  test('a wrong password says so in plain words and keeps the email', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email', { exact: true }).fill(OWNER.email);
    await page.getByLabel('Password', { exact: true }).fill('not-the-password');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.locator('form [role="alert"]')).toContainText('The email or password is not right');
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(OWNER.email);
    await expect(page).toHaveURL(/\/login$/);
  });

  test('the password can be shown and hidden', async ({ page }) => {
    await page.goto('/login');
    const pw = page.getByLabel('Password', { exact: true });
    await expect(pw).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(pw).toHaveAttribute('type', 'text');
  });

  test('login page has no accessibility violations', async ({ page }) => {
    await page.goto('/login');
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });

  test('log in, then log out ends the session', async ({ page }) => {
    await login(page, STOREKEEPER);
    await page.getByRole('button', { name: /Test Storekeeper/ }).click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('the shell, by role', () => {
  test('storekeeper: own buttons only, all of them working, no owner chips', async ({ page }) => {
    await login(page, STOREKEEPER);
    const nav = page.getByRole('navigation', { name: 'Quick buttons' });
    for (const label of ['Issue to a job', 'Return']) {
      await expect(nav.getByRole('button', { name: new RegExp(label) })).toBeEnabled();
    }
    await expect(nav.getByRole('button', { name: /Count stock/ })).toBeEnabled();
    await expect(nav.getByRole('button', { name: /Receive stock/ })).toBeEnabled();
    await expect(nav.getByRole('button', { name: 'Low stock' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'Waiting for me' })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'Stock value' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Welcome, Test.' })).toBeVisible();
    await expect(page.getByLabel('Type a message')).toBeEnabled();
  });

  test('owner: gets the owner chips; the rest sit behind More', async ({ page }) => {
    await login(page, OWNER);
    const nav = page.getByRole('navigation', { name: 'Quick buttons' });
    await expect(nav.getByRole('button', { name: 'Waiting for me' })).toBeVisible();
    await expect(nav.getByRole('button', { name: /Receive stock/ })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'More' })).toHaveCount(2); // forms and chips
  });

  test('shell has no accessibility violations (light and dark)', async ({ page }) => {
    await login(page, STOREKEEPER);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    }
  });
});

test.describe('panel', () => {
  test('? opens the shortcuts panel; Esc closes it', async ({ page, isMobile }) => {
    test.skip(isMobile, 'keyboard shortcut is for the desktop');
    await login(page, STOREKEEPER);
    await page.keyboard.press('?');
    const panel = page.getByTestId('panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Alt+R');
    await expect(panel).toContainText('Receive stock');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });

  test('desktop: panel sits beside the chat and the chat stays usable', async ({ page, isMobile }) => {
    test.skip(isMobile);
    await login(page, STOREKEEPER);
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    const panel = page.getByTestId('panel');
    const box = await panel.boundingBox();
    const vw = page.viewportSize()!.width;
    expect(box!.width / vw).toBeGreaterThan(0.4);
    expect(box!.width / vw).toBeLessThan(0.5);
    await expect(page.getByRole('navigation', { name: 'Quick buttons' })).toBeVisible();
  });

  test('phone: the panel is a full-screen sheet with Back to chat', async ({ page, isMobile }) => {
    test.skip(!isMobile);
    await login(page, OWNER);
    await page.getByRole('button', { name: /Test Owner/ }).click();
    await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
    const panel = page.getByTestId('panel');
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    const vp = page.viewportSize()!;
    expect(box!.width).toBeGreaterThanOrEqual(vp.width - 1);
    expect(box!.height).toBeGreaterThanOrEqual(vp.height - 1);
    await page.getByRole('button', { name: 'Back to chat' }).click();
    await expect(panel).toHaveCount(0);
  });

  test('phone: the top bar fits the screen, every control inside it', async ({ page, isMobile }) => {
    test.skip(!isMobile);
    await login(page, OWNER);
    const vw = page.viewportSize()!.width;
    for (const b of await page.locator('header').getByRole('button').all()) {
      const box = await b.boundingBox();
      if (!box) continue;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vw);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('phone: no sideways scrolling and the launcher row scrolls on its own', async ({ page, isMobile }) => {
    test.skip(!isMobile);
    await login(page, OWNER);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const buttons = page.getByRole('navigation', { name: 'Quick buttons' }).getByRole('button');
    for (const b of await buttons.all()) {
      const box = await b.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('theme', () => {
  test('dark choice is remembered after reload', async ({ page }) => {
    await login(page, STOREKEEPER);
    await page.getByRole('button', { name: /Test Storekeeper/ }).click();
    await page.getByRole('menuitem', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // put it back for the other tests
    await page.getByRole('button', { name: /Test Storekeeper/ }).click();
    await page.getByRole('menuitem', { name: 'Same as this device' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    await page.waitForTimeout(500);
  });
});

test.describe('security headers (real browser)', () => {
  for (const path of ['/', '/login']) {
    test(`${path}: CSP has frame-src about:, a nonce, and the browser reports no violations`, async ({ page }) => {
      const violations: string[] = [];
      page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) violations.push(m.text()); });
      const res = await page.goto(path);
      const csp = res!.headers()['content-security-policy'] ?? '';
      expect(csp).toContain('frame-src about:');
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();
      // Next stamped the same nonce on its scripts, so they ran.
      expect(await page.locator(`script[nonce]`).count()).toBeGreaterThan(0);
      expect(res!.headers()['x-frame-options']).toBe('DENY');
      expect(res!.headers()['x-content-type-options']).toBe('nosniff');
      await page.waitForLoadState('networkidle');
      expect(violations).toEqual([]);
    });
  }

  test('a new nonce on every request', async ({ request }) => {
    const a = (await request.get('/login')).headers()['content-security-policy'];
    const b = (await request.get('/login')).headers()['content-security-policy'];
    expect(a).not.toBe(b);
  });
});

test.describe('health', () => {
  test('/api/health is open and says ok', async ({ request }) => {
    const r = await request.get('/api/health');
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, config: 'ok', database: 'ok', guards: { missing: [] } });
    expect(body.guards.expected).toBeGreaterThan(20);
  });
});
