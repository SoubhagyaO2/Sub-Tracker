import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, addMonths } from '@subcycle/shared';
import { browserTimeZone, todayIn } from '../src/lib/dates';
import { renderApp } from './helpers';

/**
 * End-to-end smoke test against the REAL stack: the compiled-from-source API server, real PostgreSQL, real
 * sessions, real CSRF and rate-limit middleware. The UI runs in jsdom (this project has no browser automation
 * yet; Playwright arrives in Stage 9), so this proves the UI <-> API contract, not browser rendering.
 */
const API_DIR = path.resolve(process.cwd(), '../api');
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://subcycle:subcycle@localhost:5434/subcycle_test';
// This file deletes users and revokes sessions: only ever against a disposable database.
if (!/_test$/.test(decodeURIComponent(new URL(DB_URL).pathname.slice(1)))) throw new Error('smoke test refuses to run: the database name must end with "_test"');
const realFetch = globalThis.fetch;
let server: ChildProcess;
let base = '';
const jar = new Map<string, string>();
const EMAIL = `smoke-${Date.now()}@example.com`;
const PASSWORD = 'Tr0ub4dor&3-horse';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

/** fetch() for the app: relative URLs go to the real server, and cookies behave like a browser's (httpOnly, never visible to app code). */
async function browserLikeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, base);
  const headers = new Headers(init.headers);
  if (jar.size) headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  const { signal, ...rest } = init; // jsdom's AbortSignal is not Node's; emulate abort instead of passing it through
  const pending = realFetch(url, { ...rest, headers });
  const res = signal
    ? await new Promise<Response>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        pending.then(resolve, reject);
      })
    : await pending;
  for (const c of res.headers.getSetCookie()) {
    const [pair = '', ...attrs] = c.split(';').map((s) => s.trim());
    const [name = '', value = ''] = pair.split('=');
    const expired = attrs.some((a) => /^max-age=0$/i.test(a) || (/^expires=/i.test(a) && new Date(a.slice(8)).getTime() < Date.now()));
    if (expired || value === '') jar.delete(name);
    else jar.set(name, value);
  }
  return res;
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: DB_URL, LOG_LEVEL: 'silent' };
  const migrate = spawnSync(process.execPath, ['--import', 'tsx', 'src/db/migrate-cli.ts'], { cwd: API_DIR, env, encoding: 'utf8' });
  if (migrate.status !== 0) throw new Error(`migration failed: ${migrate.stderr || migrate.stdout}`);
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: API_DIR, env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await realFetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i === 99) throw new Error('API server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  vi.stubGlobal('fetch', browserLikeFetch);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  server?.kill();
  const pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
  await pool.query("DELETE FROM users WHERE email LIKE 'smoke-%@example.com'"); // cascades to everything the run created
  await pool.end();
});

/** Waits for the section's heading (pages load asynchronously), then scopes queries to that section. */
async function section(name: string | RegExp) {
  const heading = await screen.findByRole('heading', { name }, { timeout: 15000 });
  return within(heading.closest('section')!);
}

describe('real API + database: register to payment', () => {
  it('registers, adds a subscription, records payments (duplicate guard included), edits the price, records a cancellation, deletes and signs out', async () => {
    const today = todayIn(browserTimeZone());
    const firstRenewal = addDays(today, 10);
    const secondRenewal = addMonths(firstRenewal, 1);
    const { user } = renderApp('/register');

    // 1. Register. The new account lands on an honest empty dashboard.
    await user.type(await screen.findByLabelText('Name'), 'Smoke Tester');
    await user.type(screen.getByLabelText('Email'), EMAIL);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Nothing tracked yet', {}, { timeout: 15000 })).toBeInTheDocument();
    expect(jar.has('sc_sid')).toBe(true); // a real session cookie was set by the server
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);

    // 2. Add a subscription through the form.
    await user.click(screen.getAllByRole('link', { name: /Add subscription/ })[0]!);
    await user.type(await screen.findByLabelText(/Service name/), 'Smoke TV');
    await user.type(screen.getByLabelText(/Price per billing period/), '149.50');
    await user.type(screen.getByLabelText(/Next billing date/), firstRenewal);
    await user.click(screen.getByRole('button', { name: 'Add subscription' }));
    expect(await screen.findByRole('heading', { name: 'Smoke TV', level: 1 }, { timeout: 15000 })).toBeInTheDocument();
    const billing = await section('Billing');
    expect(billing.getByText(/149\.50/)).toHaveTextContent(/INR/);
    expect(billing.getByText('Estimate')).toBeInTheDocument();
    expect(await screen.findByText('No payments recorded')).toBeInTheDocument(); // creating a subscription records nothing

    // 3. Record the payment for the upcoming renewal; the server advances the date along the schedule.
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    let dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText('Which renewal does this cover?')).toHaveValue(firstRenewal);
    await user.click(dialog.getByRole('button', { name: 'Record payment' }));
    expect(await screen.findByText(/Payment recorded\. Next billing date moved to/, {}, { timeout: 15000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const payments = await section('Recorded payments');
    expect(await payments.findByText(/149\.50/)).toHaveTextContent(/INR/);
    expect(payments.getByText(/For the renewal on/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Next renewal').closest('div')!.querySelector('time')).toHaveAttribute('datetime', secondRenewal));

    // 4. Recording the same renewal again is refused by the server's duplicate guard, and the UI explains it.
    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    dialog = within(screen.getByRole('dialog'));
    await user.selectOptions(dialog.getByLabelText('Which renewal does this cover?'), firstRenewal);
    await user.click(dialog.getByRole('button', { name: 'Record payment' }));
    expect(await dialog.findAllByText(new RegExp(`already recorded for the ${firstRenewal} renewal`), {}, { timeout: 15000 })).not.toHaveLength(0);
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(payments.getAllByRole('listitem')).toHaveLength(1); // still exactly the one payment the user recorded

    // 5. The dashboard keeps the estimate and the recorded payment apart.
    await user.click(screen.getAllByRole('link', { name: /^Home$/ })[0]!);
    const monthly = await section('Monthly equivalent');
    expect(await monthly.findByText(/149\.50/, {}, { timeout: 15000 })).toHaveTextContent(/INR/);
    expect(monthly.getByText('Estimate')).toBeInTheDocument();
    const chart = await screen.findByRole('img', { name: /Recorded payments/ }, { timeout: 15000 });
    expect(chart).toHaveAccessibleName(/149\.50/);
    await user.click((await section('Recorded payments by month')).getByRole('button', { name: 'View as table' }));
    expect(within(screen.getByRole('table')).getAllByText(/149\.50/).length).toBeGreaterThan(0);

    // 5b. Stage 7 against the real server: the calendar projects the NEXT renewal (the paid one is not repeated),
    // analytics keeps recorded vs estimate vs projection apart, and the reminders page loads honestly.
    await user.click(screen.getAllByRole('link', { name: /^Calendar$/ })[0]!);
    await user.click(await screen.findByRole('button', { name: '90 days' }));
    const upcoming = await section('Upcoming');
    const rows = await upcoming.findAllByText('Smoke TV', {}, { timeout: 15000 });
    expect(rows).toHaveLength(2); // renewals ~+1 and ~+2 months after the paid one; the paid renewal itself is not repeated (3 months out is past 90 days)
    await user.click(screen.getAllByRole('link', { name: /^Analytics$/ })[0]!);
    const rec = await section('Recorded spending');
    expect(await rec.findByText('Net spent', {}, { timeout: 15000 })).toBeInTheDocument();
    expect(rec.getByText('Net spent').nextElementSibling).toHaveTextContent(/149\.50.*INR/);
    expect((await section('Recurring cost')).getByText('Monthly equivalent').nextElementSibling).toHaveTextContent(/149\.50/);
    await user.click(screen.getAllByRole('link', { name: /Reminders/ })[0]!);
    expect(await screen.findByRole('heading', { name: 'Reminder settings' }, { timeout: 15000 })).toBeInTheDocument();
    expect(await screen.findByText(/Email reminders aren’t available on this server/)).toBeInTheDocument(); // no SMTP in the test server
    await user.click(screen.getAllByRole('link', { name: /^Home$/ })[0]!);

    // 6. Edit the price: only the price (and its history note) is sent, and the change is recorded.
    await user.click(screen.getAllByRole('link', { name: /Subscriptions/ })[0]!);
    await user.click(await screen.findByRole('link', { name: /Smoke TV/ }));
    await user.click(await screen.findByRole('link', { name: 'Edit' }));
    const price = await screen.findByLabelText(/Price per billing period/);
    await user.clear(price);
    await user.type(price, '199');
    await user.type(await screen.findByLabelText('Note (optional)'), 'price rise');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved changes to Smoke TV.', {}, { timeout: 15000 })).toBeInTheDocument();
    const history = await section('Price history');
    expect(await history.findByText(/149\.50/, {}, { timeout: 15000 })).toBeInTheDocument();
    expect(history.getByText(/199\.00/)).toBeInTheDocument();
    expect(history.getByText(/price rise/)).toBeInTheDocument();

    // 7. Record a cancellation: it is the user's own status, and the UI says nothing was cancelled externally.
    await user.click(screen.getByRole('button', { name: 'Record cancellation' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('SubCycle can’t cancel Smoke TV for you.');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Record cancellation' }));
    expect(await screen.findByText(/SubCycle hasn’t cancelled anything with the provider/, {}, { timeout: 15000 })).toBeInTheDocument();
    expect(await screen.findByText(/You recorded this cancellation on/)).toBeInTheDocument();

    // 8. Delete it for good (removing its payment and history), then sign out.
    await user.click(screen.getByRole('button', { name: 'Delete Smoke TV' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByText('Deleted Smoke TV.', {}, { timeout: 15000 })).toBeInTheDocument();
    expect(await screen.findByText('No subscriptions yet')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: /Sign out/ })[0]!);
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(jar.has('sc_sid')).toBe(false); // the server cleared the cookie
  }, 120_000);

  it('a wrong password on the real server gives the generic message', async () => {
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), EMAIL);
    await user.type(screen.getByLabelText('Password'), 'definitely the wrong one');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert', {}, { timeout: 15000 })).toHaveTextContent('Incorrect email or password.');
  }, 30_000);

  it('after signing in again on the real server, protected pages work; a server-revoked session returns to sign-in with a plain notice', async () => {
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), EMAIL);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: /Smoke/ }, { timeout: 15000 })).toBeInTheDocument();

    // Revoke the session in the database, as expiry or a password change would.
    const pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
    await pool.query("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = $1)", [EMAIL]);
    await pool.end();

    await user.click(screen.getAllByRole('link', { name: /Subscriptions/ })[0]!);
    expect(await screen.findByRole('heading', { name: 'Welcome back' }, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your session has ended. Please sign in again.');
    expect(document.body).not.toHaveTextContent(/UNAUTHENTICATED|Authentication required/);
  }, 60_000);
});

describe('real API + database: account settings', () => {
  it('changes preferences and password (old password stops working), then deletes the account for good', async () => {
    const email = `smoke-settings-${Date.now()}@example.com`;
    const newPassword = 'Correct-Horse-9-battery';
    jar.clear(); // a fresh browser: the previous test left its session cookie behind
    const { user } = renderApp('/register');
    await user.type(await screen.findByLabelText('Name'), 'Settings Tester');
    await user.type(screen.getByLabelText('Email'), email);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByText('Nothing tracked yet', {}, { timeout: 15000 });

    // preferences: persisted by the server, applied to the document
    await user.click(screen.getAllByRole('button', { name: /Account menu/ })[0]!);
    await user.click(screen.getAllByRole('link', { name: 'Settings' }).find((l) => l.closest('#account-menu'))!);
    const prefs = await section('Region');
    await user.selectOptions(prefs.getByLabelText('Preferred currency'), 'USD');
    await user.selectOptions(prefs.getByLabelText('Time zone'), 'Pacific/Auckland');
    await user.click(prefs.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Settings saved.', {}, { timeout: 15000 })).toBeInTheDocument();
    const pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
    const saved = await pool.query("SELECT currency, timezone FROM user_preferences WHERE user_id = (SELECT id FROM users WHERE email = $1)", [email]);
    expect(saved.rows[0]).toEqual({ currency: 'USD', timezone: 'Pacific/Auckland' });

    // password: wrong current is refused in place; the right one succeeds and the OLD password no longer signs in
    const pw = await section('Change password');
    await user.type(pw.getByLabelText('Current password'), 'not-my-password-1');
    await user.type(pw.getByLabelText('New password'), newPassword);
    await user.type(pw.getByLabelText('Repeat the new password'), newPassword);
    await user.click(pw.getByRole('button', { name: 'Change password' }));
    expect((await screen.findAllByText('Your current password is incorrect.', {}, { timeout: 15000 })).length).toBeGreaterThan(0);
    await user.clear(pw.getByLabelText('Current password'));
    await user.type(pw.getByLabelText('Current password'), PASSWORD);
    await user.click(pw.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/Password changed\./, {}, { timeout: 15000 })).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: /Sign out/ })[0]!);
    await screen.findByRole('heading', { name: 'Welcome back' });
    await user.type(screen.getByLabelText('Email'), email);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert', {}, { timeout: 15000 })).toHaveTextContent('Incorrect email or password.');
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), newPassword);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Settings', level: 1 }, { timeout: 15000 }); // sign-in returns to where the session ended

    // deletion: password + typed email, then the account is really gone
    await user.click((await section('Delete account')).getByRole('button', { name: 'Delete account…' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Your password'), newPassword);
    await user.type(dialog.getByLabelText(/to confirm/), email);
    await user.click(dialog.getByRole('button', { name: 'Delete my account forever' }));
    expect(await screen.findByRole('heading', { name: 'Welcome back' }, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('permanently deleted');
    expect(jar.has('sc_sid')).toBe(false);
    const gone = await pool.query('SELECT (SELECT count(*) FROM users WHERE email = $1)::int AS users, (SELECT count(*) FROM user_preferences)::int AS prefs_total', [email]);
    expect(gone.rows[0].users).toBe(0);
    await pool.end();
  }, 120_000);
});
