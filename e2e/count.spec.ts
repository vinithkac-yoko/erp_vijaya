import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMaterials, prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); });
test.describe.configure({ timeout: 90_000 }); // the whole-story tests use two people and many steps
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });

const NINE = [
  { name: '22 SWG Copper Wire', uom: 'KG' as const, qty: '145', rate: '812' },
  { name: 'Ferrite Core E-30', qty: '18', rate: '65' },
  { name: 'Bobbin Type-B', qty: '640', rate: '9' },
  { name: 'Insulation Tape', uom: 'MTR' as const, qty: '820', rate: '3.10' },
  { name: 'Varnish', uom: 'LTR' as const, qty: '38', rate: '340' },
  { name: 'Paint', uom: 'LTR' as const, qty: '12', rate: '420' },
  { name: 'Thinner', uom: 'LTR' as const, qty: '20', rate: '150' },
  { name: 'Stickers', qty: '3000', rate: '0.50' },
  { name: 'Copper Scrap', uom: 'KG' as const, qty: '0', rate: '' },
];

const buttons = (page: Page) => page.getByRole('navigation', { name: 'Quick buttons' });
const form = (page: Page, name: string) => page.getByRole('form', { name });
const saved = (page: Page) => page.getByRole('region', { name: 'Saved' }).last(); // the newest card
const sheet = (page: Page) => page.getByTestId('count-sheet');

async function startOpening(page: Page) {
  await buttons(page).getByRole('button', { name: /Count stock/ }).click();
  const f = form(page, 'Start a stock count');
  await expect(f.getByLabel('This is the opening count (go-live, done once)')).toBeChecked(); // the only count that can come first
  await f.getByRole('button', { name: 'Start count' }).click();
  await expect(saved(page)).toContainText('✓ COUNT STARTED');
  await page.getByRole('button', { name: 'Open the count sheet' }).click();
  await expect(sheet(page)).toBeVisible();
}

/** Type a row and leave the box: the sheet saves it by itself. */
async function row(page: Page, name: string, qty: string, rate?: string) {
  await page.getByLabel(`Counted, ${name}`).fill(qty);
  if (rate !== undefined && rate !== '') { await page.getByLabel(`Rate, ${name}`).fill(rate); await page.getByLabel(`Rate, ${name}`).press('Tab'); }
  else await page.getByLabel(`Counted, ${name}`).press('Tab');
}
const countedInDb = () => prisma.stockCountLine.count({ where: { countedQty: { not: null } } });

test.describe('the opening count, as the storekeeper does it', () => {
  test('Count stock starts it, the sheet saves by itself, and it is all still there the next day', async ({ page }) => {
    await addMaterials(NINE.map(({ name, uom }) => ({ name, uom, isScrap: name === 'Copper Scrap' })));
    await login(page, STOREKEEPER);
    await buttons(page).getByRole('button', { name: /Count stock/ }).click();
    const f = form(page, 'Start a stock count');
    await expect(f.getByTestId('form-info')).toContainText('opening count has not been done yet');
    await expect(f.getByLabel('Date of the count')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await f.getByRole('button', { name: 'Start count' }).click();
    await expect(saved(page)).toContainText('CNT-');
    await expect(saved(page)).toContainText('Opening count · 9 materials');
    await expect(saved(page)).toContainText('The invoice number is optional');
    expect(await prisma.stockCount.count({ where: { isOpening: true, status: 'DRAFT' } })).toBe(1);

    await page.getByRole('button', { name: 'Open the count sheet' }).click();
    await expect(page.getByTestId('progress')).toHaveText('0 of 9 counted');
    await expect(page.getByRole('columnheader', { name: /System|Difference|Reason/ })).toHaveCount(0); // the opening count has none of these
    await expect(page.getByRole('button', { name: 'Send to owner' })).toBeDisabled();
    await expect(page.getByTestId('send-reason')).toHaveText('9 materials not counted');

    await row(page, '22 SWG Copper Wire', '142.6');
    await expect(page.getByTestId('progress')).toHaveText('1 of 9 counted');
    await expect(page.getByTestId('save-state')).toHaveText('✓ Saved');
    await expect(page.getByText('still needs rate')).toBeVisible(); // quantity first, rate when the invoice is to hand
    await page.getByLabel('Rate, 22 SWG Copper Wire').fill('812');
    await page.getByLabel('Invoice number, 22 SWG Copper Wire').fill('CCW/2627/0388');
    await page.getByLabel('Invoice number, 22 SWG Copper Wire').press('Tab');
    await expect.poll(async () => (await prisma.stockCountLine.findFirst({ where: { sourceInvoiceNo: 'CCW/2627/0388' } }))?.unitRate?.toString()).toBe('812');
    expect(Number((await prisma.stockCountLine.findFirstOrThrow({ where: { countedQty: { not: null } } })).countedQty)).toBe(142.6); // the rate did not touch the quantity
    expect(await prisma.stockCountLine.count({ where: { reasonCode: { not: null } } })).toBe(0); // no reason on an opening count
    await expect(page.getByLabel('Rate, 22 SWG Copper Wire')).not.toHaveAttribute('aria-invalid', 'true');

    // a rate of zero, and a fraction of a piece, are refused in plain words, beside the row
    await page.getByLabel('Counted, Stickers').fill('2999.5'); await page.getByLabel('Counted, Stickers').press('Tab');
    await expect(page.getByText('Stickers is counted in whole pieces.')).toBeVisible();
    await expect(page.getByLabel('Counted, Stickers')).toHaveValue(''); // put back to what is really saved
    await page.getByLabel('Counted, Insulation Tape').fill('820'); await page.getByLabel('Rate, Insulation Tape').fill('0'); await page.getByLabel('Rate, Insulation Tape').press('Tab');
    await expect(page.getByText("A rate of zero isn't allowed. Take the rate from the last purchase invoice.")).toBeVisible();

    // filters
    await page.getByRole('button', { name: /Missing rate/ }).click();
    await expect(page.getByTestId('count-row')).toHaveCount(1); // the tape: counted, no rate
    await page.getByRole('button', { name: /Not counted yet/ }).click();
    await expect(page.getByTestId('count-row')).toHaveCount(7);
    await page.getByRole('button', { name: /^All/ }).click();

    // the next day: a new chat, and the card says where he was
    await page.goto('/'); // a new chat: the opening card is drawn fresh
    await expect(page.getByText(/Opening count CNT-\d{4}-0001 is in progress: 2 of 9 counted/)).toBeVisible();
    await page.getByRole('button', { name: 'Open the count sheet' }).click();
    await expect(page.getByLabel('Counted, 22 SWG Copper Wire')).toHaveValue('142.6');
    await expect(page.getByLabel('Rate, 22 SWG Copper Wire')).toHaveValue('812');
    await expect(page.getByLabel('Invoice number, 22 SWG Copper Wire')).toHaveValue('CCW/2627/0388');
    await page.getByLabel('Counted, 22 SWG Copper Wire').fill('145'); await page.getByLabel('Counted, 22 SWG Copper Wire').press('Tab'); // "I missed a spool"
    await expect.poll(async () => Number((await prisma.stockCountLine.findFirstOrThrow({ where: { sourceInvoiceNo: 'CCW/2627/0388' } })).countedQty)).toBe(145);
    expect(await prisma.stockCount.count()).toBe(1);
    await expect(page.getByLabel('Rate, 22 SWG Copper Wire')).toHaveValue('812');
  });

  test('Count stock while one is open carries on counting: it opens the sheet, not a second count', async ({ page }) => {
    await addMaterials([{ name: 'Varnish', uom: 'LTR' }]);
    await login(page, STOREKEEPER);
    await startOpening(page);
    await page.getByRole('button', { name: 'Back to chat' }).or(page.getByRole('button', { name: 'Close panel' })).first().click();
    await buttons(page).getByRole('button', { name: /Count stock/ }).click();
    await expect(sheet(page)).toBeVisible();
    expect(await prisma.stockCount.count()).toBe(1);
  });

  test('Enter goes down to the same box on the next row', async ({ page }) => {
    await addMaterials([{ name: 'A Material' }, { name: 'B Material' }, { name: 'C Material' }]);
    await login(page, STOREKEEPER);
    await startOpening(page);
    await page.getByLabel('Counted, A Material').fill('5');
    await page.getByLabel('Counted, A Material').press('Enter');
    await expect(page.getByLabel('Counted, B Material')).toBeFocused();
    await expect.poll(countedInDb).toBe(1);
  });
});

test.describe('opening count: send, send back, fix, approve (ACCEPTANCE 2.20–2.41)', () => {
  test('the storekeeper sends it, the owner sends it back with a note, he fixes it, the owner approves, the stock is in', async ({ browser, page }) => {
    await addMaterials(NINE.map(({ name, uom, qty }) => ({ name, uom, isScrap: name === 'Copper Scrap' && qty === '0' })));
    await login(page, STOREKEEPER);
    await startOpening(page);
    for (const m of NINE) await row(page, m.name, m.qty, m.rate);
    await expect(page.getByTestId('progress')).toHaveText('9 of 9 counted');
    await expect(page.getByTestId('send-reason')).toHaveCount(0);
    await page.getByRole('button', { name: 'Send to owner' }).click();

    // the panel closes and the "send" form says what is going
    const send = form(page, 'Send count to the owner');
    await expect(send.getByTestId('form-info')).toContainText('8 materials with stock, total value ₹1,49,672.');
    await send.getByRole('button', { name: 'Send to owner' }).click();
    await expect(saved(page)).toContainText('✓ SENT TO OWNER');
    await expect(saved(page)).toContainText('Stock does not change until the owner approves.');
    expect(await prisma.stockMovement.count()).toBe(0);

    // the owner, on another screen
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const owner = await ctx.newPage();
    await login(owner, OWNER);
    await expect(owner.getByText('1 waiting for you')).toBeVisible();
    await expect(owner.getByText(/Opening count CNT-\d{4}-0001: 8 materials with stock, total value ₹1,49,672\./)).toBeVisible();
    await owner.getByRole('button', { name: 'Review it' }).click();
    const approve = form(owner, 'Approve the count');
    await expect(approve.getByTestId('form-info')).toContainText('Biggest values:');
    await expect(approve.getByTestId('form-info')).toContainText('22 SWG Copper Wire: 145 kg at ₹812 = ₹1,17,740');
    expect(await new AxeBuilder({ page: owner }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze().then((r) => r.violations.map((v) => v.id))).toEqual([]);

    // "Send back": the same card becomes the note form, with quick picks
    await approve.getByRole('button', { name: 'Send back' }).click();
    const back = form(owner, 'Send the count back');
    await back.getByLabel('What should be recounted or fixed?').fill('Recount the bobbins, 640 looks low');
    await back.getByRole('button', { name: 'Send back' }).click();
    await expect(saved(owner)).toContainText('✓ SENT BACK');
    expect((await prisma.stockCount.findFirstOrThrow()).status).toBe('REJECTED');
    expect(await prisma.stockMovement.count()).toBe(0);

    // the storekeeper is told, on his next opening card, in the owner's words
    await page.goto('/'); // a new chat: the opening card is drawn fresh
    await expect(page.getByText('Recount needed: ' + (await prisma.stockCount.findFirstOrThrow()).number + ': Recount the bobbins, 640 looks low')).toBeVisible();
    await expect(page.getByText(/is sent back: 9 of 9 counted/)).toBeVisible();
    await page.getByRole('button', { name: 'Open the count sheet' }).click();
    await expect(page.getByText('The owner sent it back:')).toBeVisible();
    await page.getByLabel('Counted, Bobbin Type-B').fill('652');
    await page.getByLabel('Counted, Bobbin Type-B').press('Tab');
    await expect.poll(async () => Number((await prisma.stockCountLine.findFirstOrThrow({ where: { material: { name: 'Bobbin Type-B' } } })).countedQty)).toBe(652);
    await page.getByRole('button', { name: 'Send to owner' }).click();
    const again = form(page, 'Send count to the owner');
    await expect(again.getByTestId('form-info')).toContainText('The owner asked: Recount the bobbins, 640 looks low'.replace('The owner asked: ', 'The owner asked: '));
    await expect(again.getByTestId('form-info')).toContainText('total value ₹1,49,780.');
    await again.getByRole('button', { name: 'Send to owner' }).click();
    await expect(saved(page)).toContainText('✓ SENT TO OWNER');

    // locked while with the owner, in the sheet too
    await page.getByRole('button', { name: 'Count stock' }).first().click();
    await expect(page.getByText(/It is with the owner, so it can't be changed now/)).toBeVisible();
    await expect(page.getByLabel('Counted, Thinner')).toBeDisabled();

    // approved
    await owner.goto('/');
    await owner.getByRole('button', { name: 'Review it' }).click();
    await expect(form(owner, 'Approve the count').getByTestId('form-info')).toContainText('total value ₹1,49,780.');
    await form(owner, 'Approve the count').getByRole('button', { name: 'Approve' }).click();
    await expect(saved(owner)).toContainText('✓ COUNT APPROVED');
    await expect(saved(owner)).toContainText('Opening stock is in at invoice rates. The system is live.');
    const total = await prisma.$queryRawUnsafe<{ t: string }[]>(`select sum("stockValue")::text t from stock_balances`);
    expect(Number(total[0]?.t)).toBe(149780);
    const kinds = await prisma.$queryRawUnsafe<{ type: string; n: bigint }[]>(`select type::text, count(*) n from stock_movements group by type`);
    expect(kinds.map((k) => [k.type, Number(k.n)])).toEqual([['OPENING', 8]]);

    // the storekeeper hears it, and asks for the stock
    await page.goto('/'); // a new chat: the opening card is drawn fresh
    await expect(page.getByText(/Opening count approved: CNT-\d{4}-0001 is approved\. Opening stock is in at invoice rates\./)).toBeVisible();
    await page.getByRole('navigation', { name: 'Quick buttons' }).getByRole('button', { name: 'Stock today' }).click();
    await expect(page.getByRole('row', { name: /Bobbin Type-B/ })).toContainText('652 pcs');
    // go-live is done: Count stock now starts a normal count, never a second opening count
    await buttons(page).getByRole('button', { name: /Count stock/ }).click();
    const next = form(page, 'Start a stock count');
    await expect(next.getByLabel('This is the opening count (go-live, done once)')).not.toBeChecked();
    await ctx.close();
  });
});

test.describe('the sheet at its limits', () => {
  test('200 materials: only the visible rows are drawn, and the whole list can still be reached', async ({ page }) => {
    await addMaterials(Array.from({ length: 200 }, (_, i) => ({ name: `Material ${String(i + 1).padStart(3, '0')}` })));
    await login(page, STOREKEEPER);
    await startOpening(page);
    await expect(page.getByTestId('progress')).toHaveText('0 of 200 counted');
    expect(await page.getByTestId('count-row').count()).toBeLessThan(60);
    await page.getByTestId('count-sheet').locator('[role="table"]').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.getByLabel('Counted, Material 200')).toBeVisible();
    await page.getByLabel('Counted, Material 200').fill('7');
    await page.getByLabel('Counted, Material 200').press('Tab');
    await expect(page.getByTestId('progress')).toHaveText('1 of 200 counted');
    await expect(page.getByTestId('send-reason')).toHaveText('199 materials not counted · 1 without a rate');
  });

  test('fits the screen, passes the accessibility scan in light and dark, and the boxes are big enough to touch', async ({ page }, info) => {
    await addMaterials([{ name: 'Varnish', uom: 'LTR' }, { name: 'Paint', uom: 'LTR' }]);
    await login(page, STOREKEEPER);
    await startOpening(page);
    await page.getByLabel('Counted, Paint').fill('12');
    await page.getByLabel('Counted, Paint').press('Tab');
    await expect(page.getByTestId('progress')).toHaveText('1 of 2 counted');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const box = await page.getByLabel('Counted, Varnish').boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(info.project.name === 'phone' ? 44 : 36);
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
      const r = await new AxeBuilder({ page }).include('[data-testid="count-sheet"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`), theme).toEqual([]);
    }
  });
});

test.describe('a normal count, once the system is live', () => {
  test('the sheet shows System, the difference signed, a reason that starts at "Don\'t know", and the owner approves it', async ({ browser, page }) => {
    await addMaterials([{ name: 'Copper Wire', uom: 'KG' }, { name: 'Ferrite Core' }]);
    // go-live, done straight in the data the way the tests of the tool do it
    await login(page, STOREKEEPER);
    await startOpening(page);
    await row(page, 'Copper Wire', '100', '800');
    await row(page, 'Ferrite Core', '50', '65');
    await page.getByRole('button', { name: 'Send to owner' }).click();
    await form(page, 'Send count to the owner').getByRole('button', { name: 'Send to owner' }).click();
    await expect(saved(page)).toContainText('✓ SENT TO OWNER');
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const owner = await ctx.newPage();
    await login(owner, OWNER);
    await owner.getByRole('button', { name: 'Review it' }).click();
    await form(owner, 'Approve the count').getByRole('button', { name: 'Approve' }).click();
    await expect(saved(owner)).toContainText('✓ COUNT APPROVED');

    await page.goto('/');
    await buttons(page).getByRole('button', { name: /Count stock/ }).click();
    const f = form(page, 'Start a stock count');
    await expect(f.getByLabel('This is the opening count (go-live, done once)')).not.toBeChecked();
    await f.getByRole('button', { name: 'Start count' }).click();
    await page.getByRole('button', { name: 'Open the count sheet' }).click();
    await expect(page.getByRole('columnheader', { name: 'System' }).or(page.getByText('System 100 kg'))).toBeVisible(); // not blind
    await page.getByLabel('Counted, Copper Wire').fill('97.5');
    await page.getByLabel('Counted, Copper Wire').press('Tab');
    await expect(page.getByLabel('Difference, Copper Wire')).toContainText('−2.5 kg'); // signed, and the sign is in the words
    const reason = page.getByLabel('Reason, Copper Wire');
    await expect(reason).toHaveValue('UNEXPLAINED'); // never asked twice; "don't know" is the honest default
    await reason.selectOption('SPILLAGE');
    await expect.poll(async () => (await prisma.stockCountLine.findFirstOrThrow({ where: { material: { name: 'Copper Wire' }, stockCount: { isOpening: false } } })).reasonCode).toBe('SPILLAGE');
    await page.getByLabel('Counted, Ferrite Core').fill('50');
    await page.getByLabel('Counted, Ferrite Core').press('Tab');
    await expect(page.getByLabel('Reason, Ferrite Core')).toHaveCount(0); // no reason when it matches
    await page.getByRole('button', { name: 'Send to owner' }).click();
    await expect(form(page, 'Send count to the owner').getByTestId('form-info')).toContainText('1 material differs: ₹2,000 short.');
    await form(page, 'Send count to the owner').getByRole('button', { name: 'Send to owner' }).click();
    await expect(saved(page)).toContainText('✓ SENT TO OWNER');
    await owner.goto('/');
    await owner.getByRole('button', { name: 'Review it' }).click();
    const info = form(owner, 'Approve the count').getByTestId('form-info');
    await expect(info).toContainText('Biggest differences:');
    await expect(info).toContainText('Copper Wire: system 100 kg, counted 97.5 kg (−2.5 kg, ₹2,000) · Spillage');
    await form(owner, 'Approve the count').getByRole('button', { name: 'Approve' }).click();
    await expect(saved(owner)).toContainText('1 adjustment posted at the current average rate');
    const adj = await prisma.stockMovement.findMany({ where: { type: 'COUNT_ADJUSTMENT' } });
    expect(adj).toHaveLength(1);
    expect(Number(adj[0]?.value)).toBe(2000);
    await ctx.close();
  });
});
