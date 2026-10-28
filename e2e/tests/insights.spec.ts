import { expect, paymentCount, test, ymd } from '../support/fixtures';
import { db } from '../support/env';

const section = (page: import('@playwright/test').Page, name: string | RegExp) =>
  page.getByRole('heading', { name }).locator('xpath=ancestor::section[1]');

/** The Estimate / Projection / Recorded label on a card (its text node is followed by a screen-reader-only explanation). */
const tag = (loc: import('@playwright/test').Locator, name: string) => loc.locator('span[title]').filter({ hasText: new RegExp(`^${name}`) }).first();

test.describe('estimates, projections and recorded spending stay apart', () => {
  test('no payments: the recorded chart is empty and nothing is estimated into it', async ({ page, signUp, addSub }) => {
    await signUp();
    await addSub({ name: 'Netflix', amountMinor: 64900, nextBillingDate: ymd(6) });
    await page.goto('/');
    await expect(section(page, 'Monthly equivalent')).toContainText('649.00');
    await expect(tag(section(page, 'Monthly equivalent'), 'Estimate')).toBeVisible();
    await expect(page.getByText('No payments recorded yet')).toBeVisible();
    await expect(page.getByText(/nothing is estimated or filled in/i).first()).toBeVisible();
    await expect(page.getByRole('img', { name: /Recorded payments/ })).toHaveCount(0);
  });

  test('currencies are never combined on the dashboard or in analytics', async ({ page, signUp, addSub, api }) => {
    await signUp();
    const inr = await addSub({ name: 'Netflix', amountMinor: 64900, currency: 'INR', nextBillingDate: ymd(6) });
    const usd = await addSub({ name: 'iCloud', amountMinor: 999, currency: 'USD', category: 'cloud_storage', nextBillingDate: ymd(8) });
    expect((await api.post(`/api/subscriptions/${inr.id}/payments`, { amountMinor: 64900, paidOn: ymd(0) })).status).toBe(201);
    expect((await api.post(`/api/subscriptions/${usd.id}/payments`, { amountMinor: 999, paidOn: ymd(0) })).status).toBe(201);

    await page.goto('/');
    const monthly = section(page, 'Monthly equivalent');
    await expect(monthly).toContainText(/649\.00\s*INR/);
    await expect(monthly).toContainText(/9\.99\s*USD/);
    await expect(tag(section(page, 'Annualized cost'), 'Projection')).toBeVisible();
    await expect(tag(section(page, 'Recorded payments by month'), 'Recorded')).toBeVisible();
    expect(await page.locator('body').innerText()).not.toMatch(/658\.99|659\.00|\b658\b/);

    const chart = section(page, 'Recorded payments by month');
    await expect(chart.getByRole('img', { name: /649\.00/ })).toBeVisible(); // INR first (preferred)
    await chart.getByLabel('Currency').selectOption('USD');
    await expect(chart.getByRole('img', { name: /9\.99/ })).toBeVisible();

    await page.goto('/analytics');
    const recorded = section(page, 'Recorded spending');
    await expect(tag(recorded, 'Recorded')).toBeVisible();
    await expect(recorded.getByText('Net spent').locator('xpath=following-sibling::dd')).toContainText(/649\.00\s*INR/);
    await expect(tag(section(page, 'Recurring cost'), 'Estimate')).toBeVisible();
    await expect(tag(section(page, 'Coming up'), 'Projection')).toBeVisible();
    await page.getByLabel('Currency').selectOption('USD');
    await expect(recorded.getByText('Net spent').locator('xpath=following-sibling::dd')).toContainText(/9\.99\s*USD/);
    expect(await page.locator('body').innerText()).not.toMatch(/658\.99/);
  });

  test('refunds and failed payments are handled honestly in recorded spending', async ({ page, signUp, addSub, api }) => {
    await signUp();
    const sub = await addSub({ name: 'Netflix', amountMinor: 64900, nextBillingDate: ymd(6) });
    for (const [amountMinor, status] of [[64900, 'paid'], [10000, 'refunded'], [99999, 'failed']] as const) {
      expect((await api.post(`/api/subscriptions/${sub.id}/payments`, { amountMinor, status, paidOn: ymd(0) })).status).toBe(201);
    }
    await page.goto('/analytics');
    const recorded = section(page, 'Recorded spending');
    await expect(recorded.getByText('Net spent').locator('xpath=following-sibling::dd')).toContainText('549.00'); // 649 - 100
    await expect(recorded).toContainText('+1 failed, not counted');
    expect(await page.locator('body').innerText()).not.toContain('999.99');
  });
});

test.describe('calendar', () => {
  test('keyboard: arrows move the selected day and focus, Page Down changes month, Home/End jump within the week', async ({ page, signUp, addSub }) => {
    await signUp();
    await addSub({ name: 'Netflix', amountMinor: 64900, nextBillingDate: ymd(2) });
    await page.goto('/calendar');
    const grid = page.getByRole('grid');
    await expect(grid).toBeVisible();

    const stop = grid.locator('button[tabindex="0"]');
    await expect(stop).toHaveCount(1); // one tab stop for the whole grid
    await expect(stop).toHaveAttribute('aria-current', 'date');
    await stop.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const focused = page.locator(':focus');
    await expect(focused).toHaveAttribute('aria-label', /1 renewal/); // two days ahead is the Netflix renewal
    await expect(page.getByRole('heading', { name: 'Netflix' }).or(page.getByRole('link', { name: /Netflix/ })).first()).toBeVisible();

    await page.keyboard.press('Home');
    const monday = await page.locator(':focus').getAttribute('aria-label');
    expect(monday).toMatch(/Mon/);
    await page.keyboard.press('End');
    expect(await page.locator(':focus').getAttribute('aria-label')).toMatch(/Sun/);

    // Month navigation from a fresh state (End above may already have moved into the next month).
    await page.reload();
    await expect(grid).toBeVisible();
    const title = page.locator('#cal-grid-h');
    const before = await title.innerText();
    await grid.locator('button[tabindex="0"]').focus();
    await page.keyboard.press('PageDown');
    await expect(title).not.toHaveText(before);
    await page.keyboard.press('PageUp');
    await expect(title).toHaveText(before);
    await page.keyboard.press('PageUp'); // never into the past
    await expect(title).toHaveText(before);
    await expect(page.getByRole('button', { name: 'Previous month' })).toBeDisabled();
  });

  test('every weekly occurrence is listed, trials are events without a charge, paused ones are absent', async ({ page, signUp, addSub, api }) => {
    await signUp();
    await addSub({ name: 'Weekly box', amountMinor: 12000, billingFrequency: 'weekly', nextBillingDate: ymd(1) });
    await addSub({ name: 'Free trial', amountMinor: 29900, status: 'trial', trialEndDate: ymd(4), nextBillingDate: ymd(4) });
    const paused = await addSub({ name: 'Paused one', amountMinor: 5000, nextBillingDate: ymd(3) });
    expect((await api.post(`/api/subscriptions/${paused.id}/status`, { action: 'pause' })).status).toBe(200);
    await page.goto('/calendar');
    await page.getByRole('button', { name: '30 days' }).click();
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible();
    const weekly = page.getByRole('link', { name: /Weekly box/ });
    await expect.poll(() => weekly.count()).toBeGreaterThanOrEqual(4);
    await expect(page.getByText('Free trial ends').first()).toBeVisible();
    await expect(page.getByText('charged after the trial')).toBeVisible();
    await expect(page.getByText('Paused one')).toHaveCount(0);
    await expect(page.getByText(/1 free trial ends \(no charge counted yet\)/)).toBeVisible();
  });
});

test.describe('reminders', () => {
  test('preferences persist, and the email option is truthfully unavailable without an email provider', async ({ page, signUp }) => {
    await signUp();
    await page.goto('/reminders');
    await expect(page.getByText(/Email reminders aren’t available on this server/)).toBeVisible();
    await expect(page.getByLabel('Also email me')).toBeDisabled();

    const lead = page.getByLabel(/Remind me this many days before/);
    await lead.fill('7');
    await page.getByLabel('At this time').selectOption('18');
    await page.getByRole('button', { name: 'Save reminder settings' }).click();
    await expect(page.getByText('Reminder settings saved.')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(/Remind me this many days before/)).toHaveValue('7');
    await expect(page.getByLabel('At this time')).toHaveValue('18');

    await page.getByLabel(/Remind me this many days before/).fill('99');
    await page.getByRole('button', { name: 'Save reminder settings' }).click();
    await expect(page.getByText('Enter a whole number of days from 0 to 60.').first()).toBeVisible();
  });
});

test.describe('scheduler-driven behaviour (real background scheduler, 30-second cycle)', () => {
  test('a stale date rolls forward WITHOUT a payment; in-app reminders are delivered and can be dismissed; email is honestly skipped', async ({ page, signUp, addSub, api }) => {
    test.setTimeout(150_000);
    const account = await signUp();
    // The API refuses a past date at creation, so recreate the state the app would be in after 45 days of nobody opening it:
    // the schedule (anchor) and the saved next date both sit 45 days back.
    const stale = await addSub({ name: 'Stale plan', amountMinor: 50000, nextBillingDate: ymd(10) });
    await db().query('UPDATE subscriptions SET anchor_date = $2, next_billing_date = $2, start_date = $2 WHERE id = $1 AND user_id = $3', [stale.id, ymd(-45), account.id]);
    await addSub({ name: 'Soon plan', amountMinor: 64900, nextBillingDate: ymd(2) });
    // Turning email on plans email reminders too; with no provider they must end up skipped, never sent.
    expect((await api.patch('/api/preferences', { emailRemindersEnabled: true })).status).toBe(200);

    // The renewal date passing must never fabricate a payment: before and after the scheduler, there are none.
    expect(await paymentCount(account.id)).toBe(0);
    // Wait for the SPECIFIC outcomes (a cycle may already have run between the setup calls above), each by polling its own condition.
    const poll = { timeout: 100_000, intervals: [2_000] };
    await expect
      .poll(async () => ((await api.get('/api/reminders?channel=in_app&status=sent')).body.data as { subscriptionName: string }[]).some((r) => r.subscriptionName === 'Soon plan'), poll)
      .toBe(true);
    await expect
      .poll(async () => ((await api.get('/api/reminders?channel=email&status=skipped')).body.data as { subscriptionName: string }[]).some((r) => r.subscriptionName === 'Soon plan'), poll)
      .toBe(true);
    await expect
      .poll(async () => ((await db().query('SELECT next_billing_date::text AS d FROM subscriptions WHERE id = $1', [stale.id])).rows[0].d as string) >= ymd(0), poll)
      .toBe(true); // rolled forward to the first schedule date on or after today
    expect(await paymentCount(account.id)).toBe(0);

    await page.goto(`/subscriptions/${stale.id}`);
    await expect(page.getByText('No payments recorded')).toBeVisible();

    await page.goto('/reminders');
    const inbox = section(page, 'Inbox');
    await expect(inbox.getByText(/Soon plan renews/)).toBeVisible();
    await expect(inbox.getByText('New', { exact: true }).first()).toBeVisible();
    const sidebarBadge = page.getByRole('link', { name: /Reminders/ }).first();
    await expect(sidebarBadge).toContainText('unread');
    await inbox.getByRole('button', { name: /Mark as read: reminder for Soon plan/ }).click();
    await expect(inbox.getByText('New', { exact: true })).toHaveCount(0);
    await expect(sidebarBadge).not.toContainText('unread');

    const log = section(page, 'Delivery log');
    await expect(log.getByText(/Not sent: This server has no email provider configured\./).first()).toBeVisible();
    await expect(log.getByText('Skipped').first()).toBeVisible();
    const emailRows = await api.get('/api/reminders?channel=email');
    expect(emailRows.body.data.length).toBeGreaterThan(0);
    for (const r of emailRows.body.data) {
      expect(r.status).not.toBe('sent');
      expect(r.sentAt).toBeNull();
    }
  });
});
