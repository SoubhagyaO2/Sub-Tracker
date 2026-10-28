import { NEW_PASSWORD, PASSWORD, expect, fillSignIn, sessionsOf, test, userExists } from '../support/fixtures';
import type { Page } from '@playwright/test';

const card = (page: Page, name: string) => page.getByRole('heading', { name }).locator('xpath=ancestor::section[1]');

test.describe('preferences', () => {
  test('there is no theme choice (the app is dark); currency and time zone persist across reloads and apply on every route', async ({ page, signUp, api }) => {
    await signUp();
    await page.goto('/settings');
    const prefs = card(page, 'Region');
    await expect(prefs.getByRole('radio', { name: 'Light' })).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await prefs.getByLabel('Preferred currency').selectOption('USD');
    await prefs.getByLabel('Time zone').selectOption('Pacific/Kiritimati');
    await prefs.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();

    // Reload: everything comes back from the server, not from browser storage.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    const again = card(page, 'Region');
    await expect(again.getByLabel('Preferred currency')).toHaveValue('USD');
    await expect(again.getByLabel('Time zone')).toHaveValue('Pacific/Kiritimati');
    expect(await page.evaluate(() => window.localStorage.length + window.sessionStorage.length)).toBe(0);

    // The new-subscription form defaults to the preferred currency.
    await page.goto('/subscriptions/new');
    await expect(page.getByLabel('Currency')).toHaveValue('USD');

    // "Today" now follows the saved zone: UTC+14 is already a day ahead for part of every day.
    const expected = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati' }).format(new Date());
    expect((await api.get('/api/calendar/renewals')).body.meta.today).toBe(expected);
    expect((await api.get('/api/preferences')).body.data).toMatchObject({ currency: 'USD', timezone: 'Pacific/Kiritimati' });
  });

  test('a saved currency or time-zone change never rewrites subscriptions or payments', async ({ page, signUp, addSub, api }) => {
    await signUp();
    const sub = await addSub({ name: 'Netflix', amountMinor: 64900, currency: 'INR' });
    await api.post(`/api/subscriptions/${sub.id}/payments`, { amountMinor: 64900, paidOn: new Date().toISOString().slice(0, 10) });
    const before = JSON.stringify([(await api.get(`/api/subscriptions/${sub.id}`)).body.data, (await api.get(`/api/subscriptions/${sub.id}/payments`)).body.data]);
    await page.goto('/settings');
    const prefs = card(page, 'Region');
    await prefs.getByLabel('Preferred currency').selectOption('JPY');
    await prefs.getByLabel('Time zone').selectOption('Pacific/Pago_Pago');
    await prefs.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    const after = JSON.stringify([(await api.get(`/api/subscriptions/${sub.id}`)).body.data, (await api.get(`/api/subscriptions/${sub.id}/payments`)).body.data]);
    expect(after).toBe(before);
    await page.goto('/');
    await expect(card(page, 'Monthly equivalent')).toContainText(/649\.00\s*INR/); // still rupees: nothing was converted
  });

  test('invalid input is refused before and after the server', async ({ page, signUp, api }) => {
    await signUp();
    expect((await api.patch('/api/preferences', { timezone: 'EST' })).status).toBe(422);
    expect((await api.patch('/api/preferences', { currency: 'XXX' })).status).toBe(422);
    expect((await api.patch('/api/preferences', { theme: 'blue' })).status).toBe(422);
    await page.goto('/settings');
    await card(page, 'Region').getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('You haven’t changed anything yet.')).toBeVisible();
  });
});

test.describe('password change', () => {
  test('wrong current password is refused in place; a correct change signs out other devices and the old password stops working', async ({ page, browser, signUp }) => {
    const account = await signUp();
    // A second device signed in with the same account.
    const other = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '10.77.0.1' } });
    try {
      const otherPage = await other.newPage();
      await otherPage.goto('/login');
      await fillSignIn(otherPage, account.email);
      await expect(otherPage.getByText('Nothing tracked yet')).toBeVisible();
      expect(await sessionsOf(account.id)).toBe(2);

      await page.goto('/settings');
      const pw = card(page, 'Change password');
      await pw.getByLabel('Current password').fill('not my password 1');
      await pw.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
      await pw.getByLabel('Repeat the new password').fill(NEW_PASSWORD);
      await pw.getByRole('button', { name: 'Change password' }).click();
      await expect(page.getByText('Your current password is incorrect.').first()).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible(); // still signed in, not bounced to login
      expect(await sessionsOf(account.id)).toBe(2);

      await pw.getByLabel('Current password').fill(PASSWORD);
      await pw.getByRole('button', { name: 'Change password' }).click();
      await expect(page.getByText(/Password changed\. 1 other session was signed out/)).toBeVisible();
      expect(await sessionsOf(account.id)).toBe(1); // only the fresh one issued to this browser
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible(); // this browser stays signed in

      // The other device is out.
      await otherPage.getByRole('link', { name: 'Calendar' }).first().click();
      await expect(otherPage.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

      // Old password no longer works; the new one does.
      await fillSignIn(otherPage, account.email, PASSWORD);
      await expect(otherPage.getByRole('alert')).toContainText('Incorrect email or password.');
      await fillSignIn(otherPage, account.email, NEW_PASSWORD);
      await expect(otherPage.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0);
    } finally {
      await other.close();
    }
  });

  test('client-side checks: mismatch, too short and unchanged passwords', async ({ page, signUp }) => {
    await signUp();
    await page.goto('/settings');
    const pw = card(page, 'Change password');
    await pw.getByLabel('Current password').fill(PASSWORD);
    await pw.getByLabel('New password', { exact: true }).fill('short');
    await pw.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText(/at least 10 characters/).first()).toBeVisible();
    await pw.getByLabel('New password', { exact: true }).fill(PASSWORD);
    await pw.getByLabel('Repeat the new password').fill(PASSWORD);
    await pw.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText(/different from your current one/).first()).toBeVisible();
    await pw.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await pw.getByLabel('Repeat the new password').fill(NEW_PASSWORD + 'x');
    await pw.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('The two new passwords don’t match.').first()).toBeVisible();
  });
});

test.describe('account deletion', () => {
  test('wrong confirmation details change nothing; correct ones delete everything and the app makes no further authenticated request', async ({ page, signUp, addSub, api }) => {
    const account = await signUp();
    const sub = await addSub({ name: 'Netflix', amountMinor: 64900 });
    await api.post(`/api/subscriptions/${sub.id}/payments`, { amountMinor: 64900, paidOn: new Date().toISOString().slice(0, 10) });
    await page.goto('/settings');
    await card(page, 'Delete account').getByRole('button', { name: 'Delete account…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete your account permanently?' });
    await expect(dialog).toContainText('Backups kept by whoever runs this server can still hold your data');
    await expect(dialog.getByLabel('Your password')).toBeFocused();
    const submit = dialog.getByRole('button', { name: 'Delete my account forever' });

    // Wrong email: the button stays disabled.
    await dialog.getByLabel('Your password').fill(PASSWORD);
    await dialog.getByLabel(/to confirm/).fill('someone-else@example.com');
    await expect(submit).toBeDisabled();

    // Wrong password: the server refuses, the dialog stays, nothing is deleted.
    await dialog.getByLabel('Your password').fill('definitely not it');
    await dialog.getByLabel(/to confirm/).fill(account.email);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(dialog.getByText('Your password is incorrect.').first()).toBeVisible();
    expect(await userExists(account.id)).toBe(true);
    await expect(page.getByRole('dialog')).toBeVisible();

    // Escape closes without deleting, and focus returns to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete account…' })).toBeFocused();
    expect(await userExists(account.id)).toBe(true);

    // Correct details. Record every API request from here on.
    await page.getByRole('button', { name: 'Delete account…' }).click();
    await dialog.getByLabel('Your password').fill(PASSWORD);
    await dialog.getByLabel(/to confirm/).fill(account.email.toUpperCase());
    const requests: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/')) requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await submit.click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Your account and its data have been permanently deleted.');
    await page.waitForLoadState('networkidle');
    expect(requests).toEqual(['DELETE /api/account']); // nothing else: no /me, no logout, no refetch with a dead session

    expect(await userExists(account.id)).toBe(false);
    expect((await page.context().cookies()).some((c) => c.name === 'sc_sid' && c.value !== '')).toBe(false);
    await fillSignIn(page, account.email);
    await expect(page.getByRole('alert')).toContainText('Incorrect email or password.');
  });
});
