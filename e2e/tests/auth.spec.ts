import { randomBytes } from 'node:crypto';
import { EMAIL_DOMAIN, EMAIL_PREFIX, deleteTestUsers } from '../support/env';
import { PASSWORD, expect, expireSessions, fillSignIn, revokeSessions, sessionsOf, signInWithUi, test } from '../support/fixtures';

test.describe('authentication', () => {
  test('register through the UI, see the real verification state, sign out, reject bad credentials, sign in', async ({ page }) => {
    const email = `${EMAIL_PREFIX}${randomBytes(6).toString('hex')}${EMAIL_DOMAIN}`;
    try {
      await page.goto('/register');
      await page.getByLabel('Name').fill('Eve E2E');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page.getByText('Nothing tracked yet')).toBeVisible();

      // Verification state: this server has no email provider, so the app must say so and must not offer to send anything.
      await page.goto('/settings');
      await expect(page.getByText(/Not verified\. Verification is unavailable because this server has no email provider/)).toBeVisible();
      await page.goto('/reminders');
      await expect(page.getByText(/Email reminders aren’t available on this server/)).toBeVisible();
      await expect(page.getByRole('button', { name: /Send verification email/ })).toHaveCount(0);

      // The session cookie is invisible to scripts and nothing is kept in web storage.
      const session = (await page.context().cookies()).find((c) => c.name === 'sc_sid')!;
      expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
      expect(await page.evaluate(() => document.cookie)).toBe('');
      expect(await page.evaluate(() => window.localStorage.length + window.sessionStorage.length)).toBe(0);

      await page.getByRole('button', { name: 'Sign out' }).first().click();
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
      expect((await page.context().cookies()).some((c) => c.name === 'sc_sid' && c.value !== '')).toBe(false);

      // A wrong password and an unknown account give exactly the same message.
      await fillSignIn(page, email, 'definitely not the password');
      await expect(page.getByRole('alert')).toContainText('Incorrect email or password.');
      const wrong = (await page.getByRole('alert').innerText()).replace(/\s+/g, ' ');
      await page.getByLabel('Email').fill(`${EMAIL_PREFIX}nobody-${randomBytes(4).toString('hex')}${EMAIL_DOMAIN}`);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('alert')).toContainText('Incorrect email or password.');
      expect((await page.getByRole('alert').innerText()).replace(/\s+/g, ' ')).toBe(wrong);

      await signInWithUi(page, email);
      // Signing in returns to where the session ended (the Reminders page here).
      await expect(page.getByRole('heading', { name: 'Reminders', level: 1 })).toBeVisible();
    } finally {
      await deleteTestUsers([email]);
    }
  });

  test('a duplicate email is refused with a clear message', async ({ page, signUp }) => {
    const account = await signUp();
    await page.context().clearCookies();
    await page.goto('/register');
    await page.getByLabel('Name').fill('Someone Else');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toContainText(/already exists/i);
  });

  test('a revoked session returns to sign-in with a plain notice and no server details', async ({ page, signUp }) => {
    const account = await signUp();
    await page.goto('/subscriptions');
    await expect(page.getByRole('heading', { name: 'Subscriptions', level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle'); // the page's own data requests are finished, so none can race the revocation below
    expect(await sessionsOf(account.id)).toBe(1);
    await revokeSessions(account.id); // what expiry, a password change elsewhere, or an operator would do
    await page.getByRole('link', { name: 'Calendar' }).first().click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('Your session has ended. Please sign in again.');
    expect(await page.locator('body').innerText()).not.toMatch(/UNAUTHENTICATED|Authentication required|stack|Error:|ECONN|postgres|sql/i);
  });

  test('an expired session is handled the same way after a reload', async ({ page, signUp }) => {
    const account = await signUp();
    await page.goto('/analytics');
    await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
    await expireSessions(account.id);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/login');
    expect(await page.locator('body').innerText()).not.toMatch(/UNAUTHENTICATED|Authentication required/);
  });

  test('protected pages redirect to sign-in and return to the page afterwards', async ({ page, signUp }) => {
    const account = await signUp();
    await page.context().clearCookies();
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await fillSignIn(page, account.email);
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  });
});
