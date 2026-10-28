import type { Page } from '@playwright/test';
import { layoutReport, runAxe } from '../support/a11y';
import { db } from '../support/env';
import { expect, test, ymd, type Api } from '../support/fixtures';

const WIDTHS = [320, 390, 820, 1280] as const;
const THEMES = ['dark', 'light'] as const;

/** A busy account: two currencies, a very long name, a trial, a paused plan, payments, history and reminders. */
async function seed(api: Api, addSub: (i: Record<string, unknown> & { name: string; amountMinor: number }) => Promise<{ id: string }>, userId: string) {
  const long = await addSub({ name: 'An extraordinarily long service name that must wrap or truncate cleanly ok', amountMinor: 123456789, nextBillingDate: ymd(2), billingFrequency: 'yearly' });
  const inr = await addSub({ name: 'Netflix', amountMinor: 64900, nextBillingDate: ymd(3) });
  const usd = await addSub({ name: 'iCloud+', amountMinor: 999, currency: 'USD', category: 'cloud_storage', nextBillingDate: ymd(5) });
  await addSub({ name: 'Free trial', amountMinor: 29900, status: 'trial', trialEndDate: ymd(6), nextBillingDate: ymd(6) });
  const paused = await addSub({ name: 'Paused gym', amountMinor: 250000, billingFrequency: 'quarterly', category: 'fitness_health', nextBillingDate: ymd(9) });
  await api.post(`/api/subscriptions/${paused.id}/status`, { action: 'pause' });
  for (const [id, amountMinor, currency, back] of [[inr.id, 64900, 'INR', 0], [inr.id, 64900, 'INR', 31], [usd.id, 999, 'USD', 2]] as const) {
    await api.post(`/api/subscriptions/${id}/payments`, { amountMinor, currency, paidOn: ymd(-back) });
  }
  await api.patch(`/api/subscriptions/${inr.id}`, { amountMinor: 69900, priceChangeNote: 'Price rise' });
  // Deterministic reminder states for the Reminders page (the real scheduler would take up to 30s to produce these):
  // one delivered, unread in-app reminder and one honestly skipped email reminder, both for far-future dates the planner never touches.
  await db().query(
    `INSERT INTO reminders (user_id, subscription_id, kind, channel, target_date, lead_days, remind_at, status, skip_reason, sent_at)
     VALUES ($1, $2, 'renewal', 'in_app', $3, 3, now() - interval '1 hour', 'sent', NULL, now() - interval '30 minutes'),
            ($1, $2, 'renewal', 'email', $3, 3, now() - interval '1 hour', 'skipped', 'smtp_not_configured', NULL)`,
    [userId, inr.id, ymd(400)],
  );
  return { long: long.id, inr: inr.id };
}

const appPages = (ids: { long: string; inr: string }): [string, string][] => [
  ['/', 'Dashboard'],
  ['/subscriptions', 'Subscriptions'],
  ['/subscriptions/new', 'New subscription'],
  [`/subscriptions/${ids.long}`, 'Subscription with a long name'],
  [`/subscriptions/${ids.inr}`, 'Subscription detail'],
  [`/subscriptions/${ids.inr}/edit`, 'Edit subscription'],
  ['/calendar', 'Calendar'],
  ['/analytics', 'Analytics'],
  ['/reminders', 'Reminders'],
  ['/settings', 'Settings'],
];

async function settle(page: Page) {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle'); // data requests finished (no arbitrary sleeps)
  await expect(page.getByRole('status', { name: /Loading/ })).toHaveCount(0);
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`layout and axe: every page, ${theme} theme at ${width}px`, async ({ page, signUp, api, addSub }) => {
      test.setTimeout(150_000);
      const account = await signUp();
      const ids = await seed(api, addSub as never, account.id);
      expect((await api.patch('/api/preferences', { theme })).status).toBe(200);
      await page.setViewportSize({ width, height: width < 600 ? 800 : 900 });

      const problems: string[] = [];
      for (const [path, label] of appPages(ids)) {
        await page.goto(path);
        await settle(page);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        if (path === '/reminders') await expect(page.getByRole('button', { name: /Mark as read: reminder for Netflix/ }).first()).toBeVisible(); // the state the axe scan must cover
        const layout = await layoutReport(page);
        if (layout.scrollWidth > layout.clientWidth) problems.push(`${label} @${width}: horizontal overflow ${layout.scrollWidth} > ${layout.clientWidth}`);
        for (const e of layout.escaping) problems.push(`${label} @${width}: escapes viewport: ${e}`);
        for (const e of layout.tooSmall) problems.push(`${label} @${width}: target under 24px: ${e}`);
        for (const v of await runAxe(page)) problems.push(`${label} @${width}: axe ${v.id} (${v.impact}): ${v.help} -> ${v.targets.join(' | ')}`);

        // Navigation: bottom bar below the desktop breakpoint, sidebar from it.
        const mobile = page.getByRole('navigation', { name: 'Primary, mobile' });
        const side = page.getByRole('navigation', { name: 'Primary', exact: true });
        if (width < 1024) {
          if (!(await mobile.isVisible())) problems.push(`${label} @${width}: bottom navigation is not visible`);
          if (await side.isVisible()) problems.push(`${label} @${width}: sidebar visible on a small screen`);
          // The fixed bottom bar must not cover the end of the page content.
          const covered = await page.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight);
            const nav = document.querySelector('nav[aria-label="Primary, mobile"]')?.getBoundingClientRect();
            const main = document.querySelector('main')?.getBoundingClientRect();
            const last = [...document.querySelectorAll('main *')].filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.getBoundingClientRect().bottom);
            return nav && main ? Math.max(...last, 0) > nav.top + 1 : false;
          });
          if (covered) problems.push(`${label} @${width}: bottom bar covers the end of the content`);
        } else {
          if (!(await side.isVisible())) problems.push(`${label} @${width}: sidebar is not visible`);
          if (await mobile.isVisible()) problems.push(`${label} @${width}: bottom bar visible on desktop`);
        }
      }
      expect(problems).toEqual([]);
    });
  }
}

test('sign-in and registration pages: no overflow and no axe violations at every width, both themes', async ({ page }) => {
  test.setTimeout(120_000);
  const problems: string[] = [];
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ['/login', '/register']) {
        await page.emulateMedia({ colorScheme: theme });
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        const layout = await layoutReport(page);
        if (layout.scrollWidth > layout.clientWidth) problems.push(`${path} @${width}: horizontal overflow`);
        for (const e of layout.escaping) problems.push(`${path} @${width}: escapes viewport: ${e}`);
        for (const v of await runAxe(page)) problems.push(`${path} @${width}/${theme}: axe ${v.id}: ${v.help} -> ${v.targets.join(' | ')}`);
      }
    }
  }
  expect(problems).toEqual([]);
});

for (const width of [320, 1280]) {
  test.describe(`keyboard, focus and dialogs at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
    });

    test('skip link is the first tab stop, becomes visible, and moves focus to the main content', async ({ page, signUp }) => {
      await signUp();
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.keyboard.press('Tab');
      const skip = page.getByRole('link', { name: 'Skip to content' });
      await expect(skip).toBeFocused();
      const box = (await skip.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.keyboard.press('Enter');
      await expect(page.locator('#main')).toBeFocused();
    });

    test('navigating moves focus to the page, and the account menu closes with Escape returning focus', async ({ page, signUp }) => {
      await signUp();
      await page.goto('/');
      await page.getByRole('link', { name: 'Calendar' }).first().click();
      await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
      await expect(page.locator('#main')).toBeFocused();
      const trigger = page.getByRole('button', { name: /Account menu/ });
      if (await trigger.isVisible()) {
        await trigger.click();
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('Escape');
        await expect(trigger).toHaveAttribute('aria-expanded', 'false');
        await expect(trigger).toBeFocused();
      }
    });

    test('payment dialog: fits the screen, traps focus, closes with Escape and restores focus', async ({ page, signUp, addSub }) => {
      await signUp();
      const sub = await addSub({ name: 'Netflix', amountMinor: 64900, nextBillingDate: ymd(5) });
      await page.goto(`/subscriptions/${sub.id}`);
      const opener = page.getByRole('button', { name: 'Record payment' });
      await opener.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(800 + 1);
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), `Tab ${i + 1} left the dialog`).toBe(true);
      }
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Shift+Tab');
        expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), `Shift+Tab ${i + 1} left the dialog`).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    });

    test('status and delete dialogs: Escape and Cancel close them without side effects', async ({ page, signUp, addSub, api }) => {
      await signUp();
      const sub = await addSub({ name: 'Gymly', amountMinor: 150000, nextBillingDate: ymd(5) });
      await page.goto(`/subscriptions/${sub.id}`);
      const pause = page.getByRole('group', { name: 'Status actions' }).getByRole('button', { name: 'Pause' });
      await pause.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(pause).toBeFocused();
      const del = page.getByRole('button', { name: 'Delete Gymly' });
      await del.click();
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(del).toBeFocused();
      expect((await api.get(`/api/subscriptions/${sub.id}`)).body.data.status).toBe('active');
    });

    test('the dialogs themselves have no axe violations in either theme', async ({ page, signUp, addSub, api }) => {
      await signUp();
      const sub = await addSub({ name: 'Netflix', amountMinor: 64900, nextBillingDate: ymd(5) });
      const problems: string[] = [];
      for (const theme of THEMES) {
        await api.patch('/api/preferences', { theme });
        await page.goto(`/subscriptions/${sub.id}`);
        await page.getByRole('button', { name: 'Record payment' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        for (const v of await runAxe(page)) problems.push(`payment dialog/${theme}: ${v.id}: ${v.help} -> ${v.targets.join(' | ')}`);
        await page.keyboard.press('Escape');
        await page.goto('/settings');
        await page.getByRole('button', { name: 'Delete account…' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        for (const v of await runAxe(page)) problems.push(`delete dialog/${theme}: ${v.id}: ${v.help} -> ${v.targets.join(' | ')}`);
        await page.keyboard.press('Escape');
      }
      expect(problems).toEqual([]);
    });

    test('charts have a text alternative and a keyboard-operable table view', async ({ page, signUp, addSub, api }) => {
      await signUp();
      const sub = await addSub({ name: 'Netflix', amountMinor: 64900, nextBillingDate: ymd(5) });
      await api.post(`/api/subscriptions/${sub.id}/payments`, { amountMinor: 64900, paidOn: ymd(0) });
      await page.goto('/');
      const chart = page.getByRole('img', { name: /Recorded payments/ });
      await expect(chart).toBeVisible();
      await expect(chart).toHaveAccessibleName(/649\.00/);
      const toggle = page.getByRole('button', { name: 'View as table' });
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('table')).toBeVisible();
      await expect(page.getByRole('table').getByRole('row').filter({ hasText: '649.00' })).toHaveCount(1);
    });
  });
}
