import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addDecisions, prisma, resetData } from './db';
import { login } from './helpers';
import { OWNER, STOREKEEPER } from './users';

test.beforeEach(async () => { await resetData(); await addDecisions(); });
test.afterAll(async () => { await resetData(); await prisma.$disconnect(); });
test.describe.configure({ timeout: 90_000 });

const say = async (page: Page, text: string) => {
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Type a message').fill(text);
  await page.getByLabel('Type a message').press('Enter');
};
const openPanel = async (page: Page) => { await page.getByRole('button', { name: /^Questions for you/ }).click(); await expect(page.getByTestId('decisions-panel')).toBeVisible(); };
const panel = (page: Page) => page.getByTestId('decisions-panel');

test.describe('the owner\'s questions (Decisions)', () => {
  test('the owner is told on the opening card and the top bar; the first questions come first; an answer is saved with a thank-you and moves to Answered', async ({ page }) => {
    await login(page, OWNER);
    await expect(page.getByRole('region', { name: 'Welcome' })).toContainText(/\d+ questions for you/);
    await expect(page.getByRole('button', { name: /^Questions for you, \d+ to answer/ })).toBeVisible();
    await page.getByRole('button', { name: 'Open the questions' }).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toContainText('to answer first');
    const first = panel(page).getByRole('button', { expanded: false }).first();
    const title = (await first.innerText()).split('\n').filter(Boolean).slice(-1)[0]!;
    await first.click();
    await expect(panel(page).getByText('What we did:').or(panel(page).getByText('Why it matters:')).first()).toBeVisible();
    await panel(page).getByRole('radio').first().check();
    await panel(page).getByRole('button', { name: 'Save my answer' }).click();
    await expect(panel(page).getByText('Saved. Thank you.')).toBeVisible();
    await panel(page).getByRole('tab', { name: /^Answered/ }).click();
    await expect(panel(page)).toContainText(title.slice(0, 30));
    expect(await prisma.decision.count({ where: { status: 'ANSWERED' } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { entityType: 'Decision', action: 'ANSWER' } })).toBe(1);
  });

  test('"Later" puts a question aside; "I don\'t know, ask the client" gives a note to copy and waits; both can come back', async ({ page }) => {
    await login(page, OWNER);
    await openPanel(page);
    await panel(page).getByRole('button', { expanded: false }).first().click();
    await panel(page).getByRole('button', { name: 'Later', exact: true }).click();
    await expect(panel(page).getByText('Put aside for later.')).toBeVisible();
    expect(await prisma.decision.count({ where: { status: 'LATER' } })).toBe(1);
    await panel(page).getByRole('button', { expanded: false }).first().click();
    await panel(page).getByRole('button', { name: "I don't know, ask the client" }).click();
    await expect(panel(page).getByLabel('Note for the client')).toContainText('Question:');
    await expect(panel(page).getByLabel('Note for the client')).toContainText('Choices:');
    await panel(page).getByLabel(/Who will you ask/).fill('Kumar, accounts');
    await panel(page).getByRole('button', { name: 'Mark as waiting for the client' }).click();
    await expect(panel(page).getByText('Marked as waiting for the client.')).toBeVisible();
    expect(await prisma.decision.findFirstOrThrow({ where: { status: 'NEEDS_CLIENT' } })).toMatchObject({ statusNote: 'Kumar, accounts' });
    await panel(page).getByRole('tab', { name: /^Later/ }).click();
    await panel(page).getByRole('button', { expanded: false }).first().click();
    await panel(page).getByRole('button', { name: 'Back to answer' }).click();
    await expect(panel(page).getByText('Back in the list to answer.')).toBeVisible();
    expect(await prisma.decision.count({ where: { status: 'LATER' } })).toBe(0);
  });

  test('"Ask the assistant about this" explains the question in the chat and saves nothing', async ({ page, isMobile }) => {
    await login(page, OWNER);
    await openPanel(page);
    await panel(page).getByRole('button', { expanded: false }).first().click();
    await panel(page).getByRole('button', { name: 'Ask the assistant about this' }).click();
    if (isMobile) await expect(page.getByTestId('decisions-panel')).toHaveCount(0);
    await expect(page.getByText('That question is about what goes on the top of your printouts.')).toBeVisible();
    expect(await prisma.decision.count({ where: { status: 'ANSWERED' } })).toBe(0);
  });

  test('he can answer in the chat: the assistant opens the form with the question and its choices; he presses the button', async ({ page }) => {
    await login(page, OWNER);
    await say(page, 'my answer on the letterhead question');
    const form = page.getByRole('form', { name: 'Answer a question' });
    await expect(form).toBeVisible();
    await expect(form.getByTestId('form-info')).toContainText(/letterhead/i);
    expect(await prisma.decision.count({ where: { status: 'ANSWERED' } })).toBe(0);
    await form.getByRole('button', { name: 'Save my answer' }).click();
    await expect(page.getByRole('region', { name: 'Saved' }).last()).toContainText('✓ ANSWER SAVED');
    expect((await prisma.decision.findFirstOrThrow({ where: { key: 'L1' } })).status).toBe('ANSWERED');
  });

  test('the storekeeper sees none of it: no button, no line on the card, no tool', async ({ page }) => {
    await login(page, STOREKEEPER);
    await expect(page.getByRole('button', { name: /^Questions for you/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Welcome' })).not.toContainText('questions for you');
    await say(page, 'my answer on the letterhead question');
    await expect(page.getByText('Only the owner answers those.')).toBeVisible();
  });

  test('the questions pass the accessibility scan in light and dark, with a card open', async ({ page }) => {
    await login(page, OWNER);
    await openPanel(page);
    await panel(page).getByRole('button', { expanded: false }).first().click();
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const r = await new AxeBuilder({ page }).include('[data-testid="panel"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${scheme} ${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    }
  });
});
