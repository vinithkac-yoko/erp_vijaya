import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); }); // leave the settings as found (the kill-switch test)

const box = (page: Page) => page.getByLabel('Type a message');
async function say(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press('Enter');
}
const form = (page: Page, name: string) => page.getByRole('form', { name });
const count = (what: 'material' | 'party' | 'user' | 'audit') =>
  what === 'material' ? prisma.material.count() : what === 'party' ? prisma.party.count() : what === 'audit' ? prisma.auditEvent.count() : prisma.user.count();

async function addFerrite(page: Page) {
  await say(page, 'add ferrite core e30, kept in stock, minimum 50');
  await expect(form(page, 'Add a material')).toBeVisible();
}

test.describe('the first card and the buttons', () => {
  test('the opening card is drawn by the server, with no model involved', async ({ page }) => {
    await login(page, STOREKEEPER);
    await expect(page.getByRole('heading', { name: 'Welcome, Test.' })).toBeVisible();
    await expect(page.getByText('Nothing is below its minimum.')).toBeVisible();
    await expect(page.getByText(/waiting for you/i)).toHaveCount(0); // owner only
    expect(await prisma.agentRun.count()).toBe(0);
  });

  test('owner: told when nothing is waiting', async ({ page }) => {
    await login(page, OWNER);
    await expect(page.getByText('Nothing is waiting for you.')).toBeVisible();
  });

  test('buttons switch on only when they can work: forms not built yet stay off, chips follow the tools', async ({ page }) => {
    await login(page, STOREKEEPER);
    const nav = page.getByRole('navigation', { name: 'Quick buttons' });
    for (const l of ['Receive stock', 'Issue to a job', 'Return']) await expect(nav.getByRole('button', { name: new RegExp(l) })).toBeDisabled();
    await expect(nav.getByRole('button', { name: 'Low stock' })).toBeEnabled();
    await expect(nav.getByRole('button', { name: 'Stock today' })).toBeEnabled();
    await expect(nav.getByRole('button', { name: 'Open jobs' })).toBeDisabled(); // no jobs yet
    await expect(box(page)).toBeEnabled();
  });
});

test.describe('asking', () => {
  test('a question is answered as it streams in, and what was looked up is a table', async ({ page }) => {
    await login(page, STOREKEEPER);
    await say(page, 'how much copper wire do we have?');
    await expect(page.getByText('how much copper wire do we have?')).toBeVisible();
    await expect(page.getByText('There is no 22 SWG Copper Wire in the list yet.')).toBeVisible();
    await expect(page.getByText("Couldn't find: copper wire. Check the spelling.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stock today' }).first()).toBeVisible(); // chips after the answer: never a blank prompt
    expect(await count('audit')).toBe(0); // reading changes nothing
  });

  test('typing is for questions; a chip sends its canned question and shows a table', async ({ page }) => {
    await login(page, STOREKEEPER);
    await addFerrite(page);
    await form(page, 'Add a material').getByRole('button', { name: 'Add material' }).click();
    await expect(page.getByText('✓ MATERIAL ADDED')).toBeVisible();
    await page.goto('/'); // a new chat: the opening card now knows
    await expect(page.getByText('1 below minimum')).toBeVisible();
    const chip = page.getByRole('navigation', { name: 'Quick buttons' }).getByRole('button', { name: /^Low stock/ });
    await expect(chip).toContainText('1');
    await chip.click();
    await expect(page.getByText('These are below their minimum.')).toBeVisible();
    const row = page.getByRole('row', { name: /Ferrite Core E-30/ });
    await expect(row).toContainText('0 pcs');
    await expect(row).toContainText('50 pcs');
  });

  test('a password typed into the chat is hidden before it is kept', async ({ page }) => {
    await login(page, OWNER);
    await say(page, 'create a login for Ravi, password is sneaky-pass-123');
    await expect(page.getByText('I hid the password you typed. Please type passwords only in the form, never in the chat.')).toBeVisible();
    await expect(page.getByText('sneaky-pass-123')).toHaveCount(0);
    const kept = JSON.stringify(await prisma.message.findMany());
    expect(kept).not.toContain('sneaky-pass-123');
  });

  test('when the assistant cannot answer, it says so in plain words and nothing breaks', async ({ page }) => {
    await login(page, STOREKEEPER);
    await say(page, 'trigger api down please');
    await expect(page.getByText("I can't answer right now. The buttons above still work.")).toBeVisible();
    await expect(page.getByText(/overloaded|529|internal details/)).toHaveCount(0);
    await expect(box(page)).toBeEnabled();
  });
});

test.describe('forms in the chat', () => {
  test('the assistant opens a form, filled in, and NOTHING is saved until the button is pressed', async ({ page }) => {
    await login(page, STOREKEEPER);
    await addFerrite(page);
    const f = form(page, 'Add a material');
    await expect(page.getByText('Check the unit and the minimum before you add it.')).toBeVisible();
    await expect(f.getByText('assistant filled this in — check it')).toBeVisible();
    await expect(f.getByLabel('Material name')).toHaveValue('Ferrite Core E-30');
    await expect(f.getByLabel('Unit')).toHaveValue('NOS');
    await expect(f.getByLabel('How is it bought?')).toHaveValue('STANDING');
    await expect(f.getByLabel('Minimum level')).toHaveValue('50');
    expect(await count('material')).toBe(0);
    expect(await count('audit')).toBe(0);
    await expect(f.getByRole('button', { name: 'Add material' })).toBeVisible(); // a verb, not "Submit"
    await expect(page.getByRole('button', { name: /^Submit$/ })).toHaveCount(0);
  });

  test('pressing the button saves once; the stamp comes from the server and survives a reload', async ({ page }) => {
    await login(page, STOREKEEPER);
    await addFerrite(page);
    await form(page, 'Add a material').getByRole('button', { name: 'Add material' }).click();
    const stamp = page.getByRole('region', { name: 'Saved' });
    await expect(stamp).toContainText('✓ MATERIAL ADDED');
    await expect(stamp).toContainText('Ferrite Core E-30');
    await expect(stamp).toContainText('Unit: pieces');
    await expect(stamp).toContainText('minimum 50 pcs');
    await expect(page.getByText('Add a material — saved')).toBeVisible(); // the form collapses to one line
    expect(await count('material')).toBe(1);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { toolName: 'create_material' } });
    expect(audit).toMatchObject({ actorType: 'AGENT', openedFrom: 'AGENT' }); // proposed by the assistant, saved by the person

    await page.reload();
    await expect(page.getByRole('region', { name: 'Saved' })).toContainText('✓ MATERIAL ADDED');
    await expect(page.getByRole('form', { name: 'Add a material' })).toHaveCount(0);
    expect(await count('material')).toBe(1);
  });

  test('"Not now" closes it and says plainly that nothing was saved', async ({ page }) => {
    await login(page, STOREKEEPER);
    await addFerrite(page);
    await form(page, 'Add a material').getByRole('button', { name: 'Not now' }).click();
    await expect(page.getByText('Nothing was saved.')).toBeVisible();
    await expect(page.getByText('Add a material — not saved')).toBeVisible();
    expect(await count('material')).toBe(0);
  });

  test('a mistake is explained next to its box, in plain words, and the form stays open', async ({ page }) => {
    await login(page, STOREKEEPER);
    await addFerrite(page);
    const f = form(page, 'Add a material');
    await f.getByLabel('Minimum level').fill('');
    await f.getByRole('button', { name: 'Add material' }).click();
    await expect(f.getByText('Material kept in stock needs a minimum level.')).toBeVisible();
    await expect(f.getByLabel('Minimum level')).toBeFocused();
    expect(await count('material')).toBe(0);
    await f.getByLabel('Minimum level').fill('50');
    await f.getByRole('button', { name: 'Add material' }).click();
    await expect(page.getByText('✓ MATERIAL ADDED')).toBeVisible();
  });

  test('the same material twice is refused where it is typed (ACCEPTANCE 1.6)', async ({ page }) => {
    await login(page, STOREKEEPER);
    await addFerrite(page);
    await form(page, 'Add a material').getByRole('button', { name: 'Add material' }).click();
    await expect(page.getByText('✓ MATERIAL ADDED')).toBeVisible();
    await addFerrite(page);
    const f = page.getByRole('form', { name: 'Add a material' });
    await f.getByRole('button', { name: 'Add material' }).click();
    await expect(f.getByText('"Ferrite Core E-30" is already in the list.')).toBeVisible();
    expect(await count('material')).toBe(1);
  });

  test('a similar name is a question; the person answers it, never the assistant (ACCEPTANCE 1.7)', async ({ page }) => {
    await login(page, STOREKEEPER);
    await say(page, 'add 22 swg copper wire');
    await form(page, 'Add a material').getByRole('button', { name: 'Add material' }).click();
    await expect(page.getByText('✓ MATERIAL ADDED')).toBeVisible();

    await say(page, 'add copper wire 22 swg');
    const f = page.getByRole('form', { name: 'Add a material' });
    await f.getByRole('button', { name: 'Add material' }).click();
    const q = f.getByRole('alert').filter({ hasText: 'looks like' });
    await expect(q).toContainText('"22 SWG Copper Wire"');
    await expect(q).not.toContainText(/MAT-|[0-9a-f]{8}-[0-9a-f]{4}/);
    await expect(f.getByRole('button', { name: 'Add material' })).toBeDisabled(); // until they answer
    expect(await count('material')).toBe(1);
    await q.getByLabel('No, mine is a different one').check();
    await f.getByRole('button', { name: 'Add material' }).click();
    await expect(page.getByText('✓ MATERIAL ADDED').nth(1)).toBeVisible();
    expect(await count('material')).toBe(2);
  });

  test('keyboard: Enter goes to the next box and Ctrl+Enter saves', async ({ page }) => {
    await login(page, STOREKEEPER);
    await addFerrite(page);
    const f = form(page, 'Add a material');
    await f.getByLabel('Material name').focus();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('name'))).toBe('uom');
    await page.keyboard.press('Control+Enter');
    await expect(page.getByText('✓ MATERIAL ADDED')).toBeVisible();
    expect(await count('material')).toBe(1);
  });

  test('a business is picked, not typed: Add supplier shows name and city in their own boxes', async ({ page }) => {
    await login(page, STOREKEEPER);
    await say(page, 'add supplier Sundaram Ferrites, Chennai');
    const f = form(page, 'Add a supplier or customer');
    await expect(f.getByLabel('Business name')).toHaveValue('Sundaram Ferrites');
    await expect(f.getByLabel('City')).toHaveValue('Chennai');
    await f.getByLabel('GSTIN').fill('33ABC');
    await f.getByRole('button', { name: 'Add to the list' }).click();
    await expect(f.getByText(/That GSTIN is not valid/)).toBeVisible();
    await f.getByLabel('GSTIN').fill('33aaacs1234k1z2');
    await f.getByRole('button', { name: 'Add to the list' }).click();
    await expect(page.getByRole('region', { name: 'Saved' })).toContainText('Sundaram Ferrites');
    await expect(page.getByRole('region', { name: 'Saved' })).toContainText('GSTIN: 33AAACS1234K1Z2');
  });

  test('form cards pass the accessibility scan in light and dark', async ({ page }) => {
    await login(page, STOREKEEPER);
    await addFerrite(page);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    }
  });

  test('fits the screen, with big enough buttons', async ({ page, isMobile }) => {
    await login(page, STOREKEEPER);
    await addFerrite(page);
    const vw = page.viewportSize()?.width ?? 0;
    const f = form(page, 'Add a material');
    const b = await f.boundingBox();
    expect(b?.x).toBeGreaterThanOrEqual(0);
    expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual(vw);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    for (const name of ['Add material', 'Not now']) expect((await f.getByRole('button', { name }).boundingBox())?.height).toBeGreaterThanOrEqual(isMobile ? 44 : 36);
  });
});

test.describe('who may do what', () => {
  test('the storekeeper asking to change the approval limit is told who does it, and gets no form', async ({ page }) => {
    await login(page, STOREKEEPER);
    await say(page, 'set the approval limit to 10 lakh');
    await expect(page.getByText('Only the owner can change the approval limit. It is ₹50,000 now.')).toBeVisible();
    await expect(page.getByRole('form')).toHaveCount(0);
    expect(await prisma.pendingAction.count()).toBe(0);
  });

  test('the owner gets the form, saves it, and the stamp shows the old and new limit', async ({ page }) => {
    await login(page, OWNER);
    await say(page, 'change the approval limit');
    const f = form(page, 'Change a setting');
    await expect(f.getByLabel('New value')).toHaveValue('75000');
    await expect(f.getByLabel('Setting')).toHaveValue('po.approval_limit');
    await f.getByRole('button', { name: 'Save setting' }).click();
    const stamp = page.getByRole('region', { name: 'Saved' });
    await expect(stamp).toContainText('✓ SETTING SAVED');
    await expect(stamp).toContainText('Purchase approval limit: ₹75,000');
    await expect(stamp).toContainText('Was: ₹50,000');
  });

  test('the owner adds a login: the password is typed in the form and kept nowhere in the chat', async ({ page }) => {
    await login(page, OWNER);
    await say(page, 'create a login for Ravi');
    const f = form(page, 'Add a login');
    await expect(f.getByLabel('Full name')).toHaveValue('Ravi Kumar');
    await expect(f.getByLabel('First password')).toHaveValue(''); // the assistant cannot fill it in
    await expect(f.getByLabel('First password')).toHaveAttribute('type', 'password');
    await f.getByLabel('First password').fill('short');
    await f.getByRole('button', { name: 'Add login' }).click();
    await expect(f.getByText('The password needs at least 10 characters.')).toBeVisible();
    await f.getByLabel('First password').fill('first-password-1');
    await f.getByRole('button', { name: 'Add login' }).click();
    await expect(page.getByRole('region', { name: 'Saved' })).toContainText('✓ LOGIN ADDED');
    await expect(page.getByText('first-password-1')).toHaveCount(0);
    expect(JSON.stringify([await prisma.message.findMany(), await prisma.auditEvent.findMany(), await prisma.pendingAction.findMany()])).not.toContain('first-password-1');
  });
});

test.describe('chats', () => {
  test('earlier chats are listed by their first words and can be opened again', async ({ page }) => {
    await login(page, STOREKEEPER);
    await say(page, 'how much copper wire do we have?');
    await expect(page.getByText('There is no 22 SWG Copper Wire in the list yet.')).toBeVisible();
    await page.goto('/');
    await expect(page.getByText('There is no 22 SWG Copper Wire in the list yet.')).toHaveCount(0); // a new chat
    await page.getByRole('button', { name: 'Chats' }).click();
    await page.getByRole('menuitem', { name: /how much copper wire/ }).click();
    await expect(page.getByText('There is no 22 SWG Copper Wire in the list yet.')).toBeVisible();
    await expect(page.getByText('how much copper wire do we have?').first()).toBeVisible();
  });

  test("a chat belongs to its owner: someone else's link opens a fresh chat, not their history", async ({ browser, page }) => {
    await login(page, OWNER);
    await say(page, 'how much copper wire do we have?');
    await expect(page.getByText('There is no 22 SWG Copper Wire in the list yet.')).toBeVisible();
    const id = new URL(page.url()).searchParams.get('c');
    expect(id).toBeTruthy();

    const ctx = await browser.newContext({ baseURL: `http://localhost:3100` });
    const other = await ctx.newPage();
    await login(other, STOREKEEPER);
    await other.goto(`/?c=${id}`);
    await expect(other.getByText('There is no 22 SWG Copper Wire in the list yet.')).toHaveCount(0);
    await expect(other.getByRole('heading', { name: 'Welcome, Test.' })).toBeVisible();
    await ctx.close();
  });
});

test.describe('the kill switch', () => {
  test('the owner switches the assistant off from the chat; then it is off for everyone, and says so', async ({ browser, page }) => {
    await login(page, OWNER);
    await say(page, 'switch the assistant off');
    const f = form(page, 'Change a setting');
    await f.getByRole('button', { name: 'Save setting' }).click();
    await expect(page.getByRole('region', { name: 'Saved' })).toContainText('Assistant: Off');

    const ctx = await browser.newContext({ baseURL: `http://localhost:3100` });
    const sk = await ctx.newPage();
    await login(sk, STOREKEEPER);
    await expect(sk.getByLabel('Type a message')).toBeDisabled();
    await expect(sk.getByPlaceholder('The assistant is off. The buttons above still work.')).toBeVisible();
    for (const chip of ['Low stock', 'Stock today']) await expect(sk.getByRole('navigation', { name: 'Quick buttons' }).getByRole('button', { name: chip })).toBeDisabled();
    const api = await sk.request.post('/api/chat', { data: { message: 'hello' } });
    expect(api.status()).toBe(200); // the server answers with the plain notice, and never calls the model
    expect(await api.text()).toContain('The assistant is off. The buttons above still work.');
    await ctx.close();
  });
});
