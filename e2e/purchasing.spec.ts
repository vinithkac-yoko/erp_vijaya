import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addJob, addMaterials, addParties, addStock, prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 120_000 });

const buttons = (page: Page) => page.getByRole('navigation', { name: 'Quick buttons' });
const form = (page: Page, name: string) => page.getByRole('form', { name });
const saved = (page: Page) => page.getByRole('region', { name: 'Saved' }).last();

async function seed() {
  await addParties([{ name: 'Ashok Transformers' }, { name: 'Sundaram Ferrites', kind: 'supplier' }, { name: 'Ravi Insulation Traders', kind: 'supplier' }, { name: 'Chennai Copper Wires', kind: 'supplier' }]);
  await addMaterials([{ name: 'Ferrite Core E-30' }, { name: 'Insulation Tape', uom: 'MTR' }, { name: '22 SWG Copper Wire', uom: 'KG' }]);
  await addStock('Ferrite Core E-30', 18, 65);
}
async function pick(page: Page | ReturnType<Page['getByRole']>, label: string, typed: string, option: string | RegExp) {
  await page.getByRole('combobox', { name: label, exact: true }).fill(typed);
  await page.getByRole('option', { name: option }).first().click();
}
test.describe('raising a purchase order (ACCEPTANCE 5.1–5.7)', () => {
  test('the rate is typed, never filled in; the total and the limit are shown live; above the limit it goes to the owner', async ({ page }) => {
    await seed();
    await addJob('Ashok Transformers', 500, [{ material: 'Ferrite Core E-30', perPiece: 2 }]);
    await login(page, STOREKEEPER);
    // New PO sits behind More until it is used
    await buttons(page).getByRole('button', { name: 'More' }).first().click();
    await page.getByRole('menuitem', { name: /New PO/ }).click();
    const f = form(page, 'Purchase order');
    await expect(f.getByTestId('form-info')).toContainText('Above ₹50,000 the owner approves it');
    await pick(f, 'Supplier', 'Sundar', /Sundaram Ferrites/);
    await pick(f, 'Material, line 1', 'Ferrite', 'Ferrite Core E-30');
    await f.getByLabel('Quantity, line 1').fill('982');
    await expect(f.getByLabel('Rate, line 1')).toHaveValue(''); // never invented
    await expect(f.getByTestId('rate-hint')).toContainText('Last paid ₹65/pcs'); // the 18 cores already there were received at ₹65: that is the hint, not a value
    await f.getByRole('button', { name: 'Raise PO' }).click();
    await expect(f.getByText("Type the rate from the supplier's quote.")).toBeVisible();
    await f.getByLabel('Rate, line 1').fill('65');
    await expect(f.getByTestId('po-amount')).toContainText('₹63,830');
    await expect(f.getByTestId('po-total')).toContainText('₹63,830');
    await expect(f.getByTestId('po-limit')).toContainText('Above ₹50,000: it goes to the owner to approve.');
    expect(await prisma.purchaseOrder.count()).toBe(0);
    await f.getByRole('button', { name: 'Raise PO' }).click();
    await expect(saved(page)).toContainText('✓ PO RAISED');
    await expect(saved(page)).toContainText('Ferrite Core E-30: 982 pcs at ₹65/pcs = ₹63,830');
    await expect(saved(page)).toContainText('so it waits for the owner. You will be told.');
    expect(await prisma.purchaseOrder.findFirstOrThrow()).toMatchObject({ status: 'PENDING_APPROVAL' });
  });

  test('a small PO is approved at once, and says so', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: 'More' }).first().click();
    await page.getByRole('menuitem', { name: /New PO/ }).click();
    const f = form(page, 'Purchase order');
    await pick(f, 'Supplier', 'Ravi', /Ravi Insulation/);
    await pick(f, 'Material, line 1', 'Tape', 'Insulation Tape');
    await f.getByLabel('Quantity, line 1').fill('500');
    await f.getByLabel('Rate, line 1').fill('3');
    await expect(f.getByTestId('po-limit')).toContainText('Within ₹50,000: it is approved at once.');
    await f.getByRole('button', { name: 'Raise PO' }).click();
    await expect(saved(page)).toContainText('Within the limit of ₹50,000, so it is approved.');
    expect(await prisma.purchaseOrder.findFirstOrThrow()).toMatchObject({ status: 'APPROVED' });
  });

  test('the last rate paid is a hint with a "Use" button; pressing it is the person typing it; a far-off rate is flagged', async ({ page }) => {
    await seed();
    const wire = await prisma.material.findFirstOrThrow({ where: { name: '22 SWG Copper Wire' } });
    await addStock('22 SWG Copper Wire', 10, 812);
    void wire;
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: 'More' }).first().click();
    await page.getByRole('menuitem', { name: /New PO/ }).click();
    const f = form(page, 'Purchase order');
    await pick(f, 'Supplier', 'Chennai', /Chennai Copper Wires/);
    await pick(f, 'Material, line 1', '22 SW', '22 SWG Copper Wire');
    await f.getByLabel('Quantity, line 1').fill('50');
    await expect(f.getByTestId('rate-hint')).toContainText('Last paid ₹812/kg');
    await expect(f.getByLabel('Rate, line 1')).toHaveValue('');
    await f.getByLabel('Rate, line 1').fill('8.12');
    await expect(f.getByText('That is far from the last rate (₹812). Check it is not a slip.')).toBeVisible();
    await f.getByLabel('Rate, line 1').fill('');
    await f.getByRole('button', { name: 'Use ₹812' }).click();
    await expect(f.getByLabel('Rate, line 1')).toHaveValue('812');
    await expect(f.getByTestId('po-amount')).toContainText('₹40,600');
    await expect(f.getByTestId('po-limit')).toContainText('Within ₹50,000');
  });
});

test.describe('approving, rejecting, receiving (ACCEPTANCE 5.14–5.17, 6.1–6.8)', () => {
  test('the whole story: shortage → PO → owner approves → storekeeper told → receipt → stock', async ({ browser, page }) => {
    await seed();
    await addJob('Ashok Transformers', 500, [{ material: 'Ferrite Core E-30', perPiece: 2 }]);
    await login(page, STOREKEEPER);
    // the PO the way the shortage button would open it: 982 filled in, the rate empty
    const job = await prisma.job.findFirstOrThrow();
    const short = await prisma.jobBomLine.findFirstOrThrow({ where: { jobId: job.id } });
    void short;
    await buttons(page).getByRole('button', { name: 'More' }).first().click();
    await page.getByRole('menuitem', { name: /New PO/ }).click();
    const f = form(page, 'Purchase order');
    await pick(f, 'Supplier', 'Sundar', /Sundaram Ferrites/);
    await pick(f, 'For which job? (if any)', 'JOB', /JOB-2627-0001/);
    await pick(f, 'Material, line 1', 'Ferrite', 'Ferrite Core E-30');
    await f.getByLabel('Quantity, line 1').fill('982');
    await f.getByLabel('Rate, line 1').fill('65');
    await f.getByRole('button', { name: 'Raise PO' }).click();
    await expect(saved(page)).toContainText('For JOB-2627-0001');

    // the owner: the card on his opening screen, then the approval with what he needs to decide
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const owner = await ctx.newPage();
    await login(owner, OWNER);
    await expect(owner.getByText(/PO-\d{4}-0001: Sundaram Ferrites, ₹63,830, for JOB-2627-0001/)).toBeVisible();
    await owner.getByRole('button', { name: 'Review it' }).click();
    const a = form(owner, 'Approve the purchase order');
    await expect(a.getByTestId('form-info')).toContainText('Sundaram Ferrites · ₹63,830');
    await expect(a.getByTestId('form-info')).toContainText('Ferrite Core E-30: 982 pcs at ₹65/pcs = ₹63,830');
    await expect(a.getByTestId('form-info')).toContainText('Why: it is for JOB-2627-0001.');
    expect(await new AxeBuilder({ page: owner }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze().then((r) => r.violations.map((v) => v.id))).toEqual([]);
    await a.getByRole('button', { name: 'Approve' }).click();
    await expect(saved(owner)).toContainText('✓ PO APPROVED');

    // the storekeeper hears it on his next opening card
    await page.goto('/');
    await expect(page.getByText(/Purchase order approved: PO-\d{4}-0001 to Sundaram Ferrites \(₹63,830\) is approved/)).toBeVisible();

    // the material arrives: pick the PO and the rest is filled in; the rate is empty with the PO's rate as a hint
    await buttons(page).getByRole('button', { name: /Receive stock/ }).click();
    const r = form(page, 'Receive stock');
    await pick(r, 'Against which purchase order? (leave empty for none)', 'PO', /PO-\d{4}-0001/);
    await expect(r.getByLabel('Arrived, line 1')).toHaveValue('982');
    await expect(r.getByLabel('Rate on the invoice, line 1')).toHaveValue('');
    await expect(r.getByTestId('rate-hint')).toContainText('PO rate ₹65/pcs');
    await expect(r.getByTestId('grn-accepted')).toContainText('982 pcs');
    await r.getByLabel('Rate on the invoice, line 1').fill('65');
    await r.getByLabel("Supplier's invoice number").fill('SF/2627/0441');
    await r.getByRole('button', { name: 'Add to stock' }).click();
    await expect(saved(page)).toContainText('✓ STOCK RECEIVED');
    await expect(saved(page)).toContainText('Ferrite Core E-30: 982 pcs arrived · 982 pcs accepted at ₹65/pcs');
    await expect(saved(page)).toContainText('Invoice SF/2627/0441');
    const bal = await prisma.stockBalance.findFirstOrThrow({ where: { material: { name: 'Ferrite Core E-30' } } });
    expect(Number(bal.quantity)).toBe(1000); // the 18 already there and the 982 that came
    expect((await prisma.purchaseOrder.findFirstOrThrow()).status).toBe('RECEIVED');
    // the shortage is gone: the follow-up offers nothing else here (issue comes with milestone 7)
    await ctx.close();
  });

  test('the owner can reject with a quick-pick reason; the storekeeper reads it', async ({ browser, page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: 'More' }).first().click();
    await page.getByRole('menuitem', { name: /New PO/ }).click();
    const f = form(page, 'Purchase order');
    await pick(f, 'Supplier', 'Sundar', /Sundaram Ferrites/);
    await pick(f, 'Material, line 1', 'Ferrite', 'Ferrite Core E-30');
    await f.getByLabel('Quantity, line 1').fill('982'); await f.getByLabel('Rate, line 1').fill('65');
    await f.getByRole('button', { name: 'Raise PO' }).click();
    await expect(saved(page)).toContainText('PO RAISED');
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const owner = await ctx.newPage();
    await login(owner, OWNER);
    await owner.getByRole('button', { name: 'Review it' }).click();
    await form(owner, 'Approve the purchase order').getByRole('button', { name: 'Reject' }).click();
    const rj = form(owner, 'Reject the purchase order');
    await rj.getByRole('button', { name: 'The rate is too high' }).click();
    await expect(rj.getByLabel(/Why\?/)).toHaveValue('The rate is too high');
    await rj.getByRole('button', { name: 'Reject' }).click();
    await expect(saved(owner)).toContainText('✓ PO REJECTED');
    expect(await prisma.stockMovement.count({ where: { type: 'RECEIPT' } })).toBe(0);
    await page.goto('/');
    await expect(page.getByText(/Purchase order rejected: PO-\d{4}-0001 to Sundaram Ferrites was rejected: The rate is too high/)).toBeVisible();
    await ctx.close();
  });

  test('50 kg arrive, 3 are sent back: the accepted 47 is worked out, a reason is asked for, stock goes up by 47', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: /Receive stock/ }).click();
    const r = form(page, 'Receive stock');
    await pick(r, 'Supplier', 'Chennai', /Chennai Copper Wires/);
    await pick(r, 'Material, line 1', '22 SW', '22 SWG Copper Wire');
    await r.getByLabel('Arrived, line 1').fill('50');
    await r.getByLabel('Sent back, line 1').fill('3');
    await expect(r.getByTestId('grn-accepted')).toContainText('47 kg');
    await r.getByLabel('Rate on the invoice, line 1').fill('812');
    await r.getByRole('button', { name: 'Add to stock' }).click();
    await expect(r.getByText('22 SWG Copper Wire: say why 3 kg is sent back.')).toBeVisible();
    await r.getByLabel('Reason sent back, line 1').fill('Damaged in transit');
    await r.getByRole('button', { name: 'Add to stock' }).click();
    await expect(saved(page)).toContainText('3 kg sent back (Damaged in transit)');
    const bal = await prisma.stockBalance.findFirstOrThrow({ where: { material: { name: '22 SWG Copper Wire' } } });
    expect(Number(bal.quantity)).toBe(47);
    expect(await prisma.stockMovement.findMany({ where: { material: { name: '22 SWG Copper Wire' } }, orderBy: { createdAt: 'asc' } }).then((m) => m.map((x) => x.type))).toEqual(['RECEIPT', 'REJECT_RETURN']);
  });

  test('material for a PO still waiting for the owner asks first (6.8)', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: 'More' }).first().click();
    await page.getByRole('menuitem', { name: /New PO/ }).click();
    let f = form(page, 'Purchase order');
    await pick(f, 'Supplier', 'Sundar', /Sundaram Ferrites/);
    await pick(f, 'Material, line 1', 'Ferrite', 'Ferrite Core E-30');
    await f.getByLabel('Quantity, line 1').fill('982'); await f.getByLabel('Rate, line 1').fill('65');
    await f.getByRole('button', { name: 'Raise PO' }).click();
    await expect(saved(page)).toContainText('PO RAISED');
    await page.goto('/');
    await buttons(page).getByRole('button', { name: /Receive stock/ }).click();
    f = form(page, 'Receive stock');
    await pick(f, 'Against which purchase order? (leave empty for none)', 'PO', /PO-\d{4}-0001/);
    await expect(f.getByTestId('form-info')).toContainText('still waiting for the owner');
    await f.getByLabel('Rate on the invoice, line 1').fill('65');
    await f.getByRole('button', { name: 'Add to stock' }).click();
    await expect(f.getByText(/is still waiting for the owner to approve it. Has the material really arrived\?/)).toBeVisible();
    expect(await prisma.goodsReceipt.count()).toBe(0);
    await f.getByLabel('Yes, that is right').check();
    await f.getByRole('button', { name: 'Add to stock' }).click();
    await expect(saved(page)).toContainText('STOCK RECEIVED');
  });
});

test.describe('the forms hold up', () => {
  test('the PO and receipt forms pass the accessibility scan in light and dark, and fit a phone', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: 'More' }).first().click();
    await page.getByRole('menuitem', { name: /New PO/ }).click();
    const f = form(page, 'Purchase order');
    await pick(f, 'Material, line 1', 'Ferrite', 'Ferrite Core E-30');
    await f.getByLabel('Quantity, line 1').fill('10');
    await f.getByLabel('Rate, line 1').fill('65');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const r = await new AxeBuilder({ page }).include('form[aria-label="Purchase order"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`), theme).toEqual([]);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await f.getByRole('button', { name: 'Not now' }).click();
    await buttons(page).getByRole('button', { name: /Receive stock/ }).click();
    const g = form(page, 'Receive stock');
    await pick(g, 'Material, line 1', 'Ferrite', 'Ferrite Core E-30');
    await g.getByLabel('Arrived, line 1').fill('10');
    await g.getByLabel('Sent back, line 1').fill('2');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const r = await new AxeBuilder({ page }).include('form[aria-label="Receive stock"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`), theme).toEqual([]);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
