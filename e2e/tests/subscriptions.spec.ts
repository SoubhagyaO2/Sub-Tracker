import { EMAIL_DOMAIN, EMAIL_PREFIX, deleteTestUsers } from '../support/env';
import { expect, paymentCount, test, ymd } from '../support/fixtures';

test.describe('subscriptions', () => {
  test('create through the form, edit the price (history is recorded), and delete with confirmation', async ({ page, signUp }) => {
    await signUp();
    await page.goto('/subscriptions/new');
    await page.getByLabel(/Service name/).fill('Streamly');
    await page.getByLabel(/Price per billing period/).fill('199.50');
    await page.getByLabel(/Next billing date/).fill(ymd(12));
    await page.getByRole('button', { name: 'Add subscription' }).click();
    await expect(page.getByRole('heading', { name: 'Streamly', level: 1 })).toBeVisible();
    await expect(page.getByText('Added Streamly.')).toBeVisible();
    // Creating a subscription records nothing as paid.
    await expect(page.getByText('No payments recorded')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Projected renewals' })).toBeVisible();

    await page.getByRole('link', { name: 'Edit' }).click();
    const price = page.getByLabel(/Price per billing period/);
    await expect(price).toHaveValue('199.50');
    await price.fill('249');
    await page.getByLabel('Note (optional)').fill('annual rise');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved changes to Streamly.')).toBeVisible();

    const history = page.getByRole('heading', { name: 'Price history' }).locator('xpath=ancestor::section[1]');
    await expect(history).toContainText('199.50');
    await expect(history).toContainText('249.00');
    await expect(history).toContainText('annual rise');

    await page.getByRole('button', { name: 'Delete Streamly' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page.getByText('Deleted Streamly.')).toBeVisible();
    await expect(page.getByText('No subscriptions yet')).toBeVisible();
  });

  test('validation: the form refuses bad input and keeps what was typed', async ({ page, signUp }) => {
    await signUp();
    await page.goto('/subscriptions/new');
    await page.getByLabel(/Price per billing period/).fill('12.345');
    await page.getByRole('button', { name: 'Add subscription' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel(/Price per billing period/)).toHaveValue('12.345');
    expect(new URL(page.url()).pathname).toBe('/subscriptions/new');
  });

  test('status transitions: only allowed actions are offered; an invalid transition is refused by the server', async ({ page, signUp, addSub, api }) => {
    await signUp();
    const sub = await addSub({ name: 'Gymly', amountMinor: 150000, nextBillingDate: ymd(5) });
    await page.goto(`/subscriptions/${sub.id}`);
    const actions = page.getByRole('group', { name: 'Status actions' });
    await expect(actions.getByRole('button', { name: 'Pause' })).toBeVisible();
    await expect(actions.getByRole('button', { name: 'Resume' })).toHaveCount(0); // not offered for an active subscription

    await actions.getByRole('button', { name: 'Pause' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByText('Paused Gymly.')).toBeVisible();
    await expect(page.getByText(/Paused: not counted/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Projected renewals' })).toHaveCount(0); // paused subscriptions do not renew

    await actions.getByRole('button', { name: 'Resume' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByText('Resumed Gymly.')).toBeVisible();

    // Recording a cancellation is the user's own record; the UI says nothing was cancelled with the provider.
    await actions.getByRole('button', { name: 'Record cancellation' }).click();
    await expect(page.getByRole('dialog')).toContainText('SubCycle can’t cancel Gymly for you.');
    await page.getByRole('dialog').getByRole('button', { name: 'Record cancellation' }).click();
    await expect(page.getByText(/SubCycle hasn’t cancelled anything with the provider/)).toBeVisible();

    // Cancelled -> pause is not a legal move: the API refuses it and nothing changes.
    const bad = await api.post(`/api/subscriptions/${sub.id}/status`, { action: 'pause' });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('INVALID_TRANSITION');
    expect((await api.get(`/api/subscriptions/${sub.id}`)).body.data.status).toBe('cancelled');
    await page.reload();
    await expect(actions.getByRole('button', { name: 'Pause' })).toHaveCount(0);
  });
});

test.describe('payments', () => {
  test('record, refuse a duplicate billing period, and delete; the billing date only moves when asked', async ({ page, signUp, addSub }) => {
    const account = await signUp();
    const first = ymd(10);
    const sub = await addSub({ name: 'Netflix', amountMinor: 64900, nextBillingDate: first });
    await page.goto(`/subscriptions/${sub.id}`);

    await page.getByRole('button', { name: 'Record payment' }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Which renewal does this cover?')).toHaveValue(first);
    await dialog.getByRole('button', { name: 'Record payment' }).click();
    await expect(page.getByText(/Payment recorded\. Next billing date moved to/)).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const payments = page.getByRole('heading', { name: 'Recorded payments' }).locator('xpath=ancestor::section[1]');
    await expect(payments).toContainText('649.00');
    await expect(payments).toContainText('INR');
    expect(await paymentCount(account.id)).toBe(1);

    // The same billing period again is refused with an explanation, and the dialog stays usable.
    await page.getByRole('button', { name: 'Record payment' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Which renewal does this cover?').selectOption(first);
    await dialog.getByRole('button', { name: 'Record payment' }).click();
    await expect(dialog.getByText(new RegExp(`already recorded for the ${first} renewal`)).first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await paymentCount(account.id)).toBe(1);

    // A same-amount payment for a different period is legitimate and is NOT rejected.
    await page.getByRole('button', { name: 'Record payment' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Which renewal does this cover?').selectOption('');
    await dialog.getByRole('button', { name: 'Record payment' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await paymentCount(account.id)).toBe(2);

    // Delete one payment: the record goes, the billing date is left alone.
    const nextBefore = (await page.getByText('Next renewal').locator('xpath=..').locator('time').first().getAttribute('datetime'))!;
    await payments.getByRole('button', { name: /Delete payment of/ }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete payment' }).click();
    await expect(page.getByText('Payment record removed. Your billing date was not changed.')).toBeVisible();
    expect(await paymentCount(account.id)).toBe(1);
    await expect(page.getByText('Next renewal').locator('xpath=..').locator('time').first()).toHaveAttribute('datetime', nextBefore);
  });

  test('a payment in another currency stays in its own currency', async ({ page, signUp, addSub }) => {
    await signUp();
    const sub = await addSub({ name: 'Netflix', amountMinor: 64900, nextBillingDate: ymd(10) });
    await page.goto(`/subscriptions/${sub.id}`);
    await page.getByRole('button', { name: 'Record payment' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Currency').selectOption('USD');
    await expect(dialog.getByText(/nothing is converted/)).toBeVisible();
    await dialog.getByLabel('Amount paid').fill('7.99');
    await dialog.getByLabel('Which renewal does this cover?').selectOption('');
    await dialog.getByRole('button', { name: 'Record payment' }).click();
    const payments = page.getByRole('heading', { name: 'Recorded payments' }).locator('xpath=ancestor::section[1]');
    await expect(payments).toContainText('7.99');
    await expect(payments).toContainText('USD');
  });

  test('upcoming renewals use the schedule, and the dashboard lists them', async ({ page, signUp, addSub }) => {
    await signUp();
    const sub = await addSub({ name: 'Weekly box', amountMinor: 12000, billingFrequency: 'weekly', nextBillingDate: ymd(3) });
    await page.goto(`/subscriptions/${sub.id}`);
    const upcoming = page.getByRole('heading', { name: 'Projected renewals' }).locator('xpath=ancestor::section[1]');
    await expect(upcoming.getByRole('listitem')).toHaveCount(3);
    await expect(upcoming).toContainText('Not a record of charges');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Upcoming renewals' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Weekly box/ }).first()).toBeVisible();
  });

  test('another user can never see or delete these records', async ({ browser, page, signUp, addSub, api }) => {
    await signUp();
    const sub = await addSub({ name: 'Private', amountMinor: 10000, nextBillingDate: ymd(4) });
    const pay = await api.post(`/api/subscriptions/${sub.id}/payments`, { amountMinor: 10000, paidOn: ymd(0) });
    expect(pay.status).toBe(201);

    const other = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '10.99.99.99' } });
    try {
      const { apiFor } = await import('../support/fixtures');
      const otherApi = apiFor(other.request);
      const email = `${EMAIL_PREFIX}other${Date.now().toString(16)}${EMAIL_DOMAIN}`;
      try {
        expect((await otherApi.post('/api/auth/register', { email, password: 'Tr0ub4dor&3-horse', displayName: 'Other' })).status).toBe(201);
        expect((await otherApi.get(`/api/subscriptions/${sub.id}`)).status).toBe(404);
        expect((await otherApi.del(`/api/subscriptions/${sub.id}/payments/${pay.body.data.payment.id}`)).status).toBe(404);
        const otherPage = await other.newPage();
        await otherPage.goto(`/subscriptions/${sub.id}`);
        await expect(otherPage.getByText('Subscription not found')).toBeVisible();
      } finally {
        await deleteTestUsers([email]);
      }
    } finally {
      await other.close();
    }
    await page.goto(`/subscriptions/${sub.id}`);
    await expect(page.getByRole('heading', { name: 'Private', level: 1 })).toBeVisible();
  });
});
