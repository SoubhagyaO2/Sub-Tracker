import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NEW_PASSWORD, PASSWORD, expect, fillSignIn, sessionsOf, test } from '../support/fixtures';
import { E2E_DATABASE_URL, WEB_ORIGIN, db } from '../support/env';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../../apps/api/dist/cli/resetLink.js', import.meta.url));

/** A token exactly as the server stores it (only the hash), for scenarios where no email can be delivered. */
async function plantToken(userId: string, ttlMs = 60 * 60 * 1000): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db().query("INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + $3 * interval '1 millisecond')", [
    userId,
    createHash('sha256').update(token).digest(),
    ttlMs,
  ]);
  return token;
}

test.describe('password reset', () => {
  test('without an email provider the page says so honestly and offers the way forward', async ({ page, signUp }) => {
    const account = await signUp();
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
    await page.getByLabel('Email').fill(account.email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('alert')).toContainText("Password reset by email isn't available on this server");
    await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
    const rows = await db().query('SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1', [account.id]);
    expect(rows.rows[0].n).toBe(0); // nothing was created or claimed as sent
  });

  test('the operator command prints a working link: new password set, every device signed out, the link works only once', async ({ page, browser, signUp, api }) => {
    const account = await signUp();
    expect(await sessionsOf(account.id)).toBe(1);

    // A second device, signed in with the old password.
    const second = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '10.77.0.9' } });
    try {
      const secondPage = await second.newPage();
      await secondPage.goto('/login');
      await fillSignIn(secondPage, account.email, account.password);
      await expect(secondPage.getByRole('heading', { level: 1 })).toBeVisible();
      await expect.poll(() => sessionsOf(account.id)).toBe(2);

      // The real built command, against the browser suite's own database.
      const { stdout } = await run(process.execPath, [CLI, account.email], {
        env: { ...process.env, NODE_ENV: 'development', DATABASE_URL: E2E_DATABASE_URL, APP_URL: WEB_ORIGIN, LOG_LEVEL: 'silent' },
      });
      const link = /(https?:\/\/\S+\/reset-password#token=[A-Za-z0-9_-]+)/.exec(stdout)?.[1];
      expect(link, 'the command prints the link').toBeTruthy();
      expect(link!.startsWith(`${WEB_ORIGIN}/reset-password#token=`)).toBe(true);

      await page.goto(link!);
      await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
      expect(page.url()).not.toContain('token'); // the secret was removed from the address bar
      await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
      await page.getByLabel('Repeat the new password').fill(NEW_PASSWORD);
      await page.getByRole('button', { name: 'Change password' }).click();
      await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();

      // Every device is signed out; the old password is dead; the new one works.
      expect(await sessionsOf(account.id)).toBe(0);
      expect((await api.get('/api/auth/me')).status).toBe(401);
      await secondPage.reload();
      await expect(secondPage.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

      await page.getByRole('link', { name: 'Sign in', exact: true }).click();
      await fillSignIn(page, account.email, PASSWORD);
      await expect(page.getByRole('alert')).toContainText('Incorrect email or password.');
      await page.getByLabel('Password').fill(NEW_PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText(/Good (morning|afternoon|evening)/);

      // The same link cannot be used again.
      await page.goto(link!);
      await page.getByLabel('New password', { exact: true }).fill('Another-Fine-Pass-7');
      await page.getByLabel('Repeat the new password').fill('Another-Fine-Pass-7');
      await page.getByRole('button', { name: 'Change password' }).click();
      await expect(page.getByRole('heading', { name: 'Link not valid' })).toBeVisible();
    } finally {
      await second.close();
    }
  });

  test('a weak password is refused without using up the link; an expired link and a link-less page explain themselves', async ({ page, signUp }) => {
    const account = await signUp();
    await page.context().clearCookies();

    const token = await plantToken(account.id);
    await page.goto(`/reset-password#token=${token}`);
    await page.getByLabel('New password', { exact: true }).fill('password1234');
    await page.getByLabel('Repeat the new password').fill('password1234');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('This password is too common. Choose something less guessable.').first()).toBeVisible();
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Repeat the new password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();

    const expired = await plantToken(account.id, -1000);
    await page.goto(`/reset-password#token=${expired}`);
    await page.getByLabel('New password', { exact: true }).fill('Yet-Another-Pass-5');
    await page.getByLabel('Repeat the new password').fill('Yet-Another-Pass-5');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('heading', { name: 'Link not valid' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('invalid or has expired');

    await page.goto('/reset-password');
    await expect(page.getByRole('alert')).toContainText('needs the link from your password reset email');
    await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();
  });
});
