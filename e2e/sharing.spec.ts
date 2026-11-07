import { expect, test, type Page } from '@playwright/test';
import { addMaterials, addParties, addStock, prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 180_000 });

const say = async (page: Page, text: string) => {
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Type a message').fill(text);
  await page.getByLabel('Type a message').press('Enter');
};
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Artifact tools' });
async function seed() {
  await addParties([{ name: 'Ashok Transformers' }]);
  await addMaterials([{ name: '22 SWG Copper Wire', uom: 'KG' }, { name: 'Ferrite Core E-30', min: 200 }]);
  await addStock('22 SWG Copper Wire', 100, 800);
  await addStock('Ferrite Core E-30', 100, 65);
}

test.describe('sharing one report with the storekeeper (ARTIFACTS §6)', () => {
  test('he gets a frozen copy that reads with HIS role; editing later changes nothing for him; stopping removes it; he cannot share, save or edit', async ({ page, browser, isMobile }) => {
    // Two people side by side at once needs room for the report beside the chat; the phone's full-screen sheet is covered in artifacts.spec.ts.
    test.skip(isMobile, 'two people at once, report beside the chat');
    await seed();
    await login(page, OWNER);
    await say(page, 'make a below minimum report');
    await expect(page.getByTestId('artifact-panel')).toBeVisible();
    await toolbar(page).getByRole('button', { name: 'Share', exact: true }).click();
    const form = page.getByRole('form', { name: 'Share with the storekeeper' });
    await expect(form).toBeVisible();
    await expect(form.getByTestId('form-info')).toContainText('Below minimum · version 1');
    await form.getByRole('button', { name: 'Share it' }).click();
    await expect(page.getByRole('region', { name: 'Saved' }).last()).toContainText('SHARED');
    expect(await prisma.artifactShare.count({ where: { revokedAt: null } })).toBe(1);

    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const him = await ctx.newPage();
    await login(him, STOREKEEPER);
    await him.getByRole('button', { name: /^Saved/ }).first().click();
    await expect(him.getByRole('menuitem', { name: /Below minimum/ })).toContainText('Shared by Test Owner · version 1');
    await him.getByRole('menuitem', { name: /Below minimum/ }).click();
    await expect(him.getByTestId('artifact-panel')).toContainText('Shared by Test Owner · version 1');
    await expect(him.frameLocator('iframe[title="Below minimum"]').locator('#app')).toContainText('Ferrite Core E-30');
    // what he may do: refresh and download; what he may not: share, save, see versions, delete
    for (const name of ['Share', 'Save', 'Stop sharing']) await expect(toolbar(him).getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(toolbar(him).getByRole('button', { name: /^Version \d/ })).toHaveCount(0);
    await expect(toolbar(him).getByRole('button', { name: 'More' })).toHaveCount(0);
    const [file] = await Promise.all([him.waitForEvent('download'), (async () => { await toolbar(him).getByRole('button', { name: 'Download' }).click(); await him.getByRole('menuitem', { name: 'Markdown' }).click(); })()]);
    expect(file.suggestedFilename()).toMatch(/^below-minimum-.*\.md$/);

    // the owner edits; his copy stays at version 1
    await say(page, 'add a supplier column');
    await expect(toolbar(page).getByRole('button', { name: /Version 2/ })).toBeVisible();
    await toolbar(him).getByRole('button', { name: 'Refresh' }).click();
    await expect(him.getByTestId('artifact-panel')).toContainText('version 1');
    await expect(him.frameLocator('iframe[title="Below minimum"]').locator('#app')).not.toContainText('Supplier');

    // the owner stops sharing; it is gone from his Saved at once, and the file is refused
    const id = (await prisma.artifact.findFirstOrThrow()).id;
    await toolbar(page).getByRole('button', { name: 'Stop sharing' }).click();
    await page.getByRole('form', { name: 'Stop sharing' }).getByRole('button', { name: 'Stop sharing' }).click();
    await expect(page.getByRole('region', { name: 'Saved' }).last()).toContainText('NOT SHARED ANY MORE');
    expect((await him.request.get(`/api/artifacts/${id}/download?format=md`)).status()).toBe(404);
    await him.getByRole('button', { name: /^Saved/ }).first().click();
    await expect(him.getByRole('menuitem', { name: /Below minimum/ })).toHaveCount(0);
    await ctx.close();
  });

  test('an owner report that reads owner-only data cannot be shared: the form says which part, and nothing is shared', async ({ page }) => {
    await seed();
    await login(page, OWNER);
    await say(page, 'make the stock position report');
    await expect(page.getByTestId('artifact-panel')).toBeVisible();
    await toolbar(page).getByRole('button', { name: 'Share', exact: true }).click();
    await expect(page.getByTestId('artifact-panel')).toContainText('owner-only data');
    await expect(page.getByTestId('artifact-panel')).toContainText('get_stock_value');
    expect(await prisma.artifactShare.count()).toBe(0);
  });

  test('the storekeeper cannot reach an owner report by its address, share through the assistant, or make an owner report of his own', async ({ page, browser }) => {
    await seed();
    await login(page, OWNER);
    await say(page, 'make the stock position report');
    await expect(page.getByTestId('artifact-panel')).toBeVisible();
    const id = (await prisma.artifact.findFirstOrThrow()).id;
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const him = await ctx.newPage();
    await login(him, STOREKEEPER);
    for (const f of ['pdf', 'docx', 'xlsx', 'csv', 'png', 'md']) expect((await him.request.get(`/api/artifacts/${id}/download?format=${f}`)).status()).toBe(404);
    await say(him, 'make the stock position report');
    await expect(him.getByText('The stock position is the owner’s report.')).toBeVisible();
    await say(him, 'share this report');
    await expect(him.getByText('Only the owner shares reports.')).toBeVisible();
    expect(await prisma.artifact.count()).toBe(1);
    await ctx.close();
  });
});
