import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMaterials, addParties, addStock, prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 90_000 });

const buttons = (page: Page) => page.getByRole('navigation', { name: 'Quick buttons' });
const form = (page: Page, name: string) => page.getByRole('form', { name });
const saved = (page: Page) => page.getByRole('region', { name: 'Saved' }).last();
const say = async (page: Page, text: string) => { await page.getByLabel('Type a message').fill(text); await page.getByLabel('Type a message').press('Enter'); };

async function seed() {
  await addParties([{ name: 'Ashok Transformers' }, { name: 'Brightline LED' }, { name: 'Sundaram Ferrites', kind: 'supplier' }]);
  await addMaterials([
    { name: '22 SWG Copper Wire', uom: 'KG' }, { name: 'Ferrite Core E-30' }, { name: 'Bobbin Type-B' }, { name: 'Insulation Tape', uom: 'MTR' }, { name: 'Varnish', uom: 'LTR' },
  ]);
  await addStock('Ferrite Core E-30', 18, 65);
}

/** New job sits behind More: the four most used forms take the row. */
async function openNewJob(page: Page) {
  await buttons(page).getByRole('button', { name: 'More' }).first().click();
  await page.getByRole('menuitem', { name: /New job/ }).click();
}

/** Pick from a type-ahead: type a few letters, press the option. */
async function pick(page: Page, label: string | RegExp, typed: string, option: string | RegExp) {
  const box = typeof label === 'string' ? page.getByLabel(label, { exact: true }) : page.getByLabel(label);
  await box.fill(typed);
  await page.getByRole('option', { name: option }).first().click();
}

async function newJob(page: Page, over: { customer?: string; po?: string; product?: string; pieces?: string; type?: 'Sample' } = {}) {
  await openNewJob(page);
  const f = form(page, 'New job');
  if (over.type) await f.getByLabel('What kind of job?').selectOption({ label: 'Sample (before the main order)' });
  await pick(f, 'Customer', (over.customer ?? 'Ashok').slice(0, 5), new RegExp(over.customer ?? 'Ashok Transformers'));
  if (over.po) await pick(f, /Customer's PO/, over.po.slice(0, 4), over.po);
  await f.getByLabel('What is being made?').fill(over.product ?? 'SMPS transformer 12V 2A');
  await f.getByLabel('Pieces').fill(over.pieces ?? '500');
  return f;
}

test.describe('a job and its BOM, as the storekeeper does it (ACCEPTANCE 4.1–4.4)', () => {
  test('New job, then the BOM with live totals, then the shortage appears without being asked', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    const f = await newJob(page);
    await expect(f.getByLabel('Job date')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await f.getByRole('button', { name: 'Create job' }).click();
    await expect(saved(page)).toContainText('✓ JOB CREATED');
    await expect(saved(page)).toContainText(/JOB-\d{4}-0001/);
    await expect(saved(page)).toContainText('Ashok Transformers · 500 pieces');
    await expect(saved(page)).toContainText('Next: add the bill of materials.');
    expect(await prisma.job.count()).toBe(1);

    // the chip carries the job into the BOM form, and the form says which job it is
    await page.getByRole('button', { name: 'Add the BOM' }).click();
    const b = form(page, 'Bill of materials');
    await expect(b.getByTestId('form-info')).toContainText('Ashok Transformers · 500 pieces');
    await expect(b.getByText('assistant filled this in')).toHaveCount(0); // it came from a button, not from the assistant

    const lines: [string, string, string, string | null, string][] = [
      ['22 SWG', '22 SWG Copper Wire', '18.4', 'g', '9.2 kg'],
      ['Ferrite', 'Ferrite Core E-30', '2', null, '1,000 pcs'],
      ['Bobbin', 'Bobbin Type-B', '1', null, '500 pcs'],
      ['Tape', 'Insulation Tape', '0.3', null, '150 m'],
      ['Varnish', 'Varnish', '5', 'ml', '2.5 L'],
    ];
    for (const [i, [typed, name, qty, , total]] of lines.entries()) {
      if (i > 0) await b.getByRole('button', { name: 'Add a material' }).click();
      const n = i + 1;
      await pick(b, `Material, line ${n}`, typed, name);
      await b.getByLabel(`Quantity for one piece, line ${n}`).fill(qty);
      await expect(b.getByRole('group', { name: `Line ${n}` }).getByTestId('bom-total')).toContainText(total); // per piece AND total, before anything is saved
    }
    await expect(b.getByLabel('Unit, line 1')).toHaveValue('small'); // grams, for the wire
    expect(await prisma.jobBomLine.count()).toBe(0); // nothing is saved yet
    await b.getByRole('button', { name: 'Save BOM' }).click();
    await expect(page.getByRole('region', { name: 'Saved' }).filter({ hasText: 'BOM SAVED' })).toContainText('22 SWG Copper Wire — 18.4 g each → 9.2 kg');
    await expect(page.getByRole('region', { name: 'Saved' }).filter({ hasText: 'BOM SAVED' })).toContainText('Varnish — 5 ml each → 2.5 L');

    // the shortage check ran by itself: cores need 1,000, have 18, short 982
    const table = page.getByRole('row', { name: /Ferrite Core E-30/ });
    await expect(table).toContainText('1,000 pcs');
    await expect(table).toContainText('18 pcs');
    await expect(table).toContainText('982 pcs');
    await expect(page.getByText('5 short.')).toBeVisible();
    const wire = await prisma.jobBomLine.findFirstOrThrow({ where: { material: { name: '22 SWG Copper Wire' } } });
    expect(Number(wire.qtyPerPiece)).toBe(0.0184);
    expect(Number(wire.requiredQty)).toBe(9.2);
  });

  test('refusals are in plain words beside the box: zero pieces, a sample with no main job, an unusual number asks once (4.11, 4.13)', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    let f = await newJob(page, { pieces: '0' });
    await f.getByRole('button', { name: 'Create job' }).click();
    await expect(f.getByText('The quantity must be more than zero.')).toBeVisible();
    await f.getByLabel('Pieces').fill('1000000');
    await f.getByRole('button', { name: 'Create job' }).click();
    await expect(f.getByText('1,000,000 pieces is a lot. Is that right?')).toBeVisible();
    await expect(f.getByRole('button', { name: 'Create job' })).toBeDisabled();
    await f.getByLabel('Yes, that is right').check();
    await f.getByRole('button', { name: 'Create job' }).click();
    await expect(saved(page)).toContainText('✓ JOB CREATED');

    // a sample must name its main job
    await page.goto('/');
    f = await newJob(page, { type: 'Sample', customer: 'Brightline LED', pieces: '5' });
    await f.getByRole('button', { name: 'Create job' }).click();
    await expect(f.getByRole('alert').filter({ hasText: /main job/i }).first()).toBeVisible();
    await pick(f, 'The main job this sample is for', 'JOB', /JOB-\d{4}-0001/);
    await f.getByRole('button', { name: 'Create job' }).click();
    await expect(saved(page)).toContainText('(sample)');
    expect(await prisma.job.count({ where: { type: 'SAMPLE', parentJobId: { not: null } } })).toBe(1);
  });

  test('a customer is picked, never typed; the PO list is that customer\'s, and waits until the customer is chosen', async ({ page }) => {
    await seed();
    const ids = await prisma.party.findMany();
    const ashok = ids.find((p) => p.name === 'Ashok Transformers');
    await prisma.customerPo.create({ data: { customerId: ashok?.id ?? '', number: 'AT/2627/118' } });
    await prisma.customerPo.create({ data: { customerId: ids.find((p) => p.name === 'Brightline LED')?.id ?? '', number: 'BL-77' } });
    await login(page, STOREKEEPER);
    await openNewJob(page);
    const f = form(page, 'New job');
    await expect(f.getByPlaceholder('Pick the customer first')).toBeVisible();
    await pick(f, 'Customer', 'Ashok', /Ashok Transformers/);
    await f.getByLabel(/Customer's PO/).fill('');
    await f.getByLabel(/Customer's PO/).click();
    await expect(page.getByRole('option', { name: /AT\/2627\/118/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /BL-77/ })).toHaveCount(0); // the other customer's PO is not offered
    await expect(page.getByRole('option', { name: /Sundaram/ })).toHaveCount(0);
  });
});

test.describe('the assistant opens a customer PO, a button carries it on to a job', () => {
  test('"record a customer PO" finds the customer by name; the chip starts the job for that PO', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await say(page, 'record a customer po from Ashok Transformers AT/2627/118');
    const f = form(page, 'Record a customer PO');
    await expect(f.getByText('assistant filled this in')).toBeVisible();
    await expect(f.getByText('Ashok Transformers')).toBeVisible(); // the name behind the id, never the id
    await expect(f.getByLabel("Customer's PO number")).toHaveValue('AT/2627/118');
    await f.getByRole('button', { name: 'Save PO' }).click();
    await expect(saved(page)).toContainText('✓ CUSTOMER PO SAVED');
    expect(await prisma.customerPo.count()).toBe(1);

    await page.getByRole('button', { name: 'Create a job for this PO' }).click();
    const j = form(page, 'New job');
    await expect(j.getByText('Ashok Transformers')).toBeVisible();
    await expect(j.getByText('AT/2627/118')).toBeVisible();
    await expect(j.getByText('assistant filled this in')).toHaveCount(0);

    // the same PO again is recognised, not duplicated (3.3)
    await page.goto('/');
    await say(page, 'record a customer po from Ashok Transformers AT/2627/118');
    await form(page, 'Record a customer PO').getByRole('button', { name: 'Save PO' }).click();
    await expect(saved(page)).toContainText('CUSTOMER PO ALREADY SAVED');
    expect(await prisma.customerPo.count()).toBe(1);
  });
});

test.describe('looking at jobs', () => {
  test('the Open jobs chip is on and shows the table', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    await expect(buttons(page).getByRole('button', { name: 'Open jobs' })).toBeEnabled(); // it asks the assistant, and says so if there are none
    const f = await newJob(page);
    await f.getByRole('button', { name: 'Create job' }).click();
    await expect(saved(page)).toContainText('JOB CREATED');
    await page.goto('/');
    await expect(buttons(page).getByRole('button', { name: 'Open jobs' })).toBeEnabled();
    await buttons(page).getByRole('button', { name: 'Open jobs' }).click();
    await expect(page.getByRole('row', { name: /JOB-\d{4}-0001/ })).toContainText('Ashok Transformers');
    await expect(page.getByRole('row', { name: /JOB-\d{4}-0001/ })).toContainText('Open');
  });
});

test.describe('the forms hold up', () => {
  test('the job form and the BOM form pass the accessibility scan in light and dark, and fit a phone', async ({ page }) => {
    await seed();
    await login(page, STOREKEEPER);
    const f = await newJob(page);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const r = await new AxeBuilder({ page }).include('form[aria-label="New job"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`), theme).toEqual([]);
    }
    await f.getByRole('button', { name: 'Create job' }).click();
    await page.getByRole('button', { name: 'Add the BOM' }).click();
    const b = form(page, 'Bill of materials');
    await pick(b, 'Material, line 1', '22 SW', '22 SWG Copper Wire');
    await b.getByLabel('Quantity for one piece, line 1').fill('18.4');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const r = await new AxeBuilder({ page }).include('form[aria-label="Bill of materials"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`), theme).toEqual([]);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test.describe('the owner\'s Settings, with the assistant off', () => {
  test('the owner opens Settings from the menu and switches the assistant back on', async ({ browser, page }) => {
    await login(page, OWNER);
    await page.getByRole('button', { name: /Test Owner, Owner/ }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    const f = form(page, 'Change a setting');
    await f.getByLabel('Setting').selectOption({ label: 'Assistant' });
    await f.getByLabel('New value').fill('off');
    await f.getByRole('button', { name: 'Save setting' }).click();
    await expect(saved(page)).toContainText('Assistant: Off');

    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const sk = await ctx.newPage();
    await login(sk, STOREKEEPER);
    await expect(sk.getByLabel('Type a message')).toBeDisabled();

    // the owner's chat is off now, but the Settings form is a form: it does not need the assistant
    await page.goto('/');
    await expect(page.getByLabel('Type a message')).toBeDisabled();
    await page.getByRole('button', { name: /Test Owner, Owner/ }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    const g = form(page, 'Change a setting');
    await g.getByLabel('Setting').selectOption({ label: 'Assistant' });
    await g.getByLabel('New value').fill('on');
    await g.getByRole('button', { name: 'Save setting' }).click();
    await expect(saved(page)).toContainText('Assistant: On');
    await sk.reload();
    await expect(sk.getByLabel('Type a message')).toBeEnabled();
    await ctx.close();

    // a storekeeper has no Settings entry
    const sk2 = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const p2 = await sk2.newPage();
    await login(p2, STOREKEEPER);
    await p2.getByRole('button', { name: /Test Storekeeper, Storekeeper/ }).click();
    await expect(p2.getByRole('menuitem', { name: 'Settings' })).toHaveCount(0);
    await sk2.close();
  });
});
