import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runSchedulerCycle } from '../src/scheduler/cycle.js';
import {
  CSRF, FakeMailer, PASSWORD, T0, captureLogs, client, createCtx, createSub, loginCookie, registerUser, remindersOf, resetDb, sessionCookie, setCookieHeader, setPrefs,
  userIdOf, verifyEmail, withFailingTrigger,
} from './helpers.js';

const captured = captureLogs();
const mailer = new FakeMailer();
const ctx = createCtx({ mailer, logger: captured.logger });
const { app, pool, clock, env } = ctx;
const NEW_PASSWORD = 'Correct-Horse-9-battery';

let userId: string;
let email: string;
let cookie: string;
let api: ReturnType<typeof client>;

beforeEach(async () => {
  await resetDb(pool);
  clock.set(T0);
  Object.assign(mailer, { sent: [], errors: [], attempts: 0, configured: true, onSend: undefined });
  captured.lines.length = 0;
  const reg = await registerUser(app);
  userId = userIdOf(reg.res);
  email = reg.email;
  cookie = reg.cookie;
  api = client(app, cookie);
});
afterAll(() => pool.end());

const count = async (table: string, where = '', params: unknown[] = []) =>
  Number((await pool.query(`SELECT count(*)::int AS n FROM ${table} ${where}`, params)).rows[0].n);
const hashOf = async (id = userId) => (await pool.query('SELECT password_hash FROM users WHERE id = $1', [id])).rows[0].password_hash as string;
const sessionCount = (id = userId) => count('sessions', 'WHERE user_id = $1', [id]);
const prefs = async () => (await api.get('/api/preferences')).body.data;

// ───────────────────────────── preferences ─────────────────────────────

describe('PATCH /api/preferences: currency, time zone, theme', () => {
  it('saves each setting and returns it from /api/preferences and /api/auth/me', async () => {
    const res = await api.patch('/api/preferences', { currency: 'USD', timezone: 'America/New_York', theme: 'light' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ currency: 'USD', timezone: 'America/New_York', theme: 'light', reminderLeadDays: 3 });
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.data.preferences).toMatchObject({ currency: 'USD', timezone: 'America/New_York', theme: 'light' });
  });

  it('persists across sessions: signing in again returns the saved theme, currency and zone', async () => {
    await api.patch('/api/preferences', { theme: 'system', currency: 'EUR', timezone: 'Europe/London' });
    const again = await request(app).post('/api/auth/login').set(CSRF).send({ email, password: PASSWORD });
    expect(again.body.data.preferences).toMatchObject({ theme: 'system', currency: 'EUR', timezone: 'Europe/London' });
  });

  it('a partial update leaves every other setting alone', async () => {
    await api.patch('/api/preferences', { theme: 'light' });
    const before = await prefs();
    await api.patch('/api/preferences', { currency: 'GBP' });
    expect(await prefs()).toEqual({ ...before, currency: 'GBP' });
  });

  it.each<[Record<string, unknown>, string]>([
    [{}, 'empty'], [{ currency: 'usd' }, 'lowercase currency'], [{ currency: 'XXX' }, 'unsupported currency'], [{ currency: 5 }, 'numeric currency'],
    [{ timezone: 'EST' }, 'abbreviation'], [{ timezone: '+05:30' }, 'fixed offset'], [{ timezone: 'Nope/Zone' }, 'unknown zone'], [{ timezone: '' }, 'empty zone'],
    [{ timezone: 'Asia/Kolkata\u0000' }, 'NUL'], [{ timezone: 'A'.repeat(200) }, 'too long'], [{ theme: 'blue' }, 'unknown theme'], [{ theme: 'DARK' }, 'wrong case'],
    [{ userId: '00000000-0000-4000-8000-000000000000', theme: 'light' }, 'userId smuggled'], [{ email: 'x@example.com' }, 'email'],
  ])('rejects %j (%s) and changes nothing', async (body) => {
    const before = await prefs();
    const res = await api.patch('/api/preferences', body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await prefs()).toEqual(before);
  });

  it('accepts real zone identifiers including old aliases and nested regions', async () => {
    for (const timezone of ['Asia/Calcutta', 'America/Argentina/Buenos_Aires', 'UTC', 'Pacific/Kiritimati', 'Etc/UTC']) {
      expect((await api.patch('/api/preferences', { timezone })).status, timezone).toBe(200);
    }
  });

  it('registration uses the same time-zone rule', async () => {
    const bad = await request(app).post('/api/auth/register').set(CSRF).send({ email: 'z@example.com', password: PASSWORD, displayName: 'Z', timezone: 'EST' });
    expect(bad.status).toBe(422);
  });

  it('requires a session and the CSRF header', async () => {
    expect((await client(app).patch('/api/preferences', { theme: 'light' })).status).toBe(401);
    expect((await request(app).patch('/api/preferences').set('Cookie', cookie).send({ theme: 'light' })).status).toBe(403);
  });

  it('one user can never change another user’s preferences', async () => {
    const other = await registerUser(app);
    const otherApi = client(app, other.cookie);
    await api.patch('/api/preferences', { theme: 'light', currency: 'JPY', timezone: 'Asia/Tokyo' });
    expect((await otherApi.get('/api/preferences')).body.data).toMatchObject({ theme: 'dark', currency: 'INR', timezone: 'Asia/Kolkata' });
  });
});

describe('changing currency or time zone never rewrites or converts anything', () => {
  async function seedData() {
    const sub = await createSub(app, cookie, { name: 'Netflix', amountMinor: 64900, currency: 'INR', nextBillingDate: '2030-02-01' });
    await createSub(app, cookie, { name: 'iCloud', amountMinor: 99, currency: 'USD', nextBillingDate: '2030-02-05' });
    await api.post(`/api/subscriptions/${sub.id}/payments`, { amountMinor: 64900, paidOn: '2030-01-10', forBillingDate: '2030-02-01' });
    return sub;
  }
  const snapshot = async () => ({
    subs: (await pool.query('SELECT id, name, amount_minor, currency, billing_frequency, anchor_date::text, next_billing_date::text, status FROM subscriptions ORDER BY id')).rows,
    pays: (await pool.query('SELECT id, amount_minor, currency, paid_on::text, status, for_billing_date::text FROM payments ORDER BY id')).rows,
    hist: (await pool.query('SELECT * FROM subscription_price_history ORDER BY id')).rows,
  });

  it('currency change: subscriptions, payments and history are byte-for-byte unchanged', async () => {
    await seedData();
    const before = await snapshot();
    expect((await api.patch('/api/preferences', { currency: 'USD' })).status).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect((await api.patch('/api/preferences', { currency: 'JPY' })).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  it('currency change: analytics still reports each currency separately in its own units', async () => {
    await seedData();
    await api.patch('/api/preferences', { currency: 'USD' });
    const a = (await api.get('/api/analytics/spending')).body.data;
    const est = Object.fromEntries(a.estimate.currencies.map((c: { currency: string; monthlyEquivalentMinor: number }) => [c.currency, c.monthlyEquivalentMinor]));
    expect(est).toEqual({ INR: 64900, USD: 99 });
    expect(a.recorded.currencies.map((c: { currency: string }) => c.currency)).toEqual(['INR']);
  });

  it('time-zone change: stored dates, payments and amounts are unchanged', async () => {
    await seedData();
    const before = await snapshot();
    expect((await api.patch('/api/preferences', { timezone: 'Pacific/Kiritimati' })).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  it('"today" follows the saved zone at the date boundary (clock 2030-01-15T10:00Z)', async () => {
    const todayOf = async () => (await api.get('/api/calendar/renewals')).body.meta.today;
    await api.patch('/api/preferences', { timezone: 'UTC' });
    expect(await todayOf()).toBe('2030-01-15');
    await api.patch('/api/preferences', { timezone: 'Pacific/Kiritimati' }); // UTC+14 -> already the 16th
    expect(await todayOf()).toBe('2030-01-16');
    await api.patch('/api/preferences', { timezone: 'Pacific/Pago_Pago' }); // UTC-11 -> still the 14th
    expect(await todayOf()).toBe('2030-01-14');
    clock.set('2030-01-15T11:30:00Z'); // 00:30 on the 15th in Pago Pago: the boundary has moved
    expect(await todayOf()).toBe('2030-01-15');
  });

  it('a renewal dated "yesterday" in the new zone is rolled forward by the scheduler, never marked paid', async () => {
    await createSub(app, cookie, { name: 'Edge', nextBillingDate: '2030-01-15' });
    await api.patch('/api/preferences', { timezone: 'Pacific/Kiritimati' }); // today is now the 16th, so the 15th is stale
    await runSchedulerCycle(env);
    const sub = (await pool.query('SELECT next_billing_date::text AS d FROM subscriptions WHERE user_id = $1', [userId])).rows[0];
    expect(sub.d).toBe('2030-02-15');
    expect(await count('payments')).toBe(0);
  });
});

describe('reminder reconciliation after preference changes', () => {
  beforeEach(async () => {
    await createSub(app, cookie, { name: 'Netflix', nextBillingDate: '2030-02-01' });
  });

  it('a time-zone change moves pending reminders in place: same rows, no duplicates, nothing marked sent', async () => {
    await runSchedulerCycle(env);
    const before = await remindersOf(pool, userId);
    expect(before.length).toBeGreaterThan(0);
    await api.patch('/api/preferences', { timezone: 'America/Los_Angeles' });
    const after = await remindersOf(pool, userId);
    const live = (rows: typeof after) => rows.filter((r) => r.status === 'pending').map((r) => `${r.target_date}|${r.channel}|${r.lead_days}`).sort();
    expect(live(after)).toEqual(live(before));
    const keys = after.map((r) => `${r.target_date}|${r.channel}|${r.lead_days}|${r.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(after.every((r) => r.status !== 'sent' && r.sent_at === null)).toBe(true);
    const row = (rows: typeof after) => rows.find((r) => r.channel === 'in_app' && r.target_date === '2030-02-01')!;
    expect(row(after).remind_at.getTime()).not.toBe(row(before).remind_at.getTime()); // 09:00 Kolkata vs 09:00 Los Angeles
    expect(row(after).remind_at.toISOString()).toBe('2030-01-29T17:00:00.000Z'); // 09:00 PST
  });

  it('an invalid saved zone cannot be written through the API, and the scheduler skips (never sends) if one is forced in', async () => {
    expect((await api.patch('/api/preferences', { timezone: 'Not/AZone' })).status).toBe(422);
    await pool.query("UPDATE user_preferences SET timezone = 'Not/AZone' WHERE user_id = $1", [userId]);
    await runSchedulerCycle(env);
    const rows = await remindersOf(pool, userId);
    expect(rows.every((r) => r.status !== 'sent')).toBe(true);
  });

  it('turning email on without SMTP creates skipped (never sent) email rows; turning it off again leaves no sent rows', async () => {
    mailer.configured = false;
    await verifyEmail(pool, userId);
    await api.patch('/api/preferences', { emailRemindersEnabled: true });
    const emailRows = (await remindersOf(pool, userId)).filter((r) => r.channel === 'email');
    expect(emailRows.length).toBeGreaterThan(0);
    expect(mailer.sent).toHaveLength(0);
    expect(emailRows.every((r) => r.status !== 'sent')).toBe(true);
  });

  it('repeating the same save changes nothing (idempotent) and a theme-only save does not touch reminders', async () => {
    await api.patch('/api/preferences', { timezone: 'Europe/Paris' });
    const a = await remindersOf(pool, userId);
    await api.patch('/api/preferences', { timezone: 'Europe/Paris' });
    await api.patch('/api/preferences', { theme: 'light' });
    expect(await remindersOf(pool, userId)).toEqual(a);
  });

  it('only the caller’s reminders are reconciled', async () => {
    const other = await registerUser(app);
    const otherId = userIdOf(other.res);
    await createSub(app, other.cookie, { name: 'Other', nextBillingDate: '2030-02-02' });
    await runSchedulerCycle(env);
    const otherBefore = await remindersOf(pool, otherId);
    await api.patch('/api/preferences', { timezone: 'Asia/Tokyo' });
    expect(await remindersOf(pool, otherId)).toEqual(otherBefore);
  });
});

// ───────────────────────────── account details ─────────────────────────────

describe('PATCH /api/account (display name)', () => {
  it('updates and trims the name; email and verification are untouched', async () => {
    const res = await api.patch('/api/account', { displayName: '  Asha R.  ' });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ displayName: 'Asha R.', email, emailVerified: false });
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.data.user.displayName).toBe('Asha R.');
  });
  it.each([[{ displayName: '' }], [{ displayName: '   ' }], [{ displayName: 'x'.repeat(81) }], [{}], [{ displayName: 'ok', email: 'new@example.com' }], [{ displayName: 'ok', passwordHash: 'x' }]])('rejects %j', async (body) => {
    expect((await api.patch('/api/account', body)).status).toBe(422);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.data.user.displayName).toBe('Test User');
  });
  it('requires a session', async () => {
    expect((await client(app).patch('/api/account', { displayName: 'x' })).status).toBe(401);
  });
});

// ───────────────────────────── password change ─────────────────────────────

describe('POST /api/account/password', () => {
  const change = (body: unknown, c = api) => c.post('/api/account/password', body);

  it('a wrong current password is a field error (422, not 401), changes nothing and issues no cookie', async () => {
    const before = await hashOf();
    const res = await change({ currentPassword: 'definitely-wrong-pass', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([{ path: 'currentPassword', message: 'Your current password is incorrect.' }]);
    expect(setCookieHeader(res)).toBeUndefined();
    expect(await hashOf()).toBe(before);
    expect((await me(cookie)).status).toBe(200); // still signed in
  });

  it.each<[string, string]>([
    ['too short', 'short1!'],
    ['too long', 'a'.repeat(129)],
    ['too common', 'password123'],
    ['contains the email', 'my-test-user-secret'],
    ['the same as the current one', PASSWORD],
  ])('rejects an invalid new password: %s', async (label, newPassword) => {
    const before = await hashOf();
    if (label === 'contains the email') await pool.query("UPDATE users SET email = 'test-user-secret@example.com' WHERE id = $1", [userId]);
    const res = await change({ currentPassword: PASSWORD, newPassword: label === 'contains the email' ? 'xx-test-user-secret-xx' : newPassword });
    expect(res.status, label).toBe(422);
    expect(await hashOf()).toBe(before);
    expect(setCookieHeader(res)).toBeUndefined();
  });

  it('rejects missing fields, wrong types and unknown keys', async () => {
    for (const body of [{}, { currentPassword: PASSWORD }, { newPassword: NEW_PASSWORD }, { currentPassword: 1, newPassword: NEW_PASSWORD }, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, userId: 'x' }]) {
      expect((await change(body)).status, JSON.stringify(body)).toBe(422);
    }
  });

  it('succeeds: new hash is Argon2id, old password stops working, new one works', async () => {
    const before = await hashOf();
    const res = await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ changed: true, otherSessionsSignedOut: 0 });
    const after = await hashOf();
    expect(after).not.toBe(before);
    expect(after.startsWith('$argon2id$')).toBe(true);
    expect((await request(app).post('/api/auth/login').set(CSRF).send({ email, password: PASSWORD })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').set(CSRF).send({ email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('SESSIONS: every session is revoked, including the one used; a fresh session is issued (no fixation), and others must sign in again', async () => {
    const second = await loginCookie(app, email);
    const third = await loginCookie(app, email);
    expect(await sessionCount()).toBe(3);
    const res = await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.otherSessionsSignedOut).toBe(2);
    const fresh = sessionCookie(res)!;
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(cookie);
    expect(await sessionCount()).toBe(1);
    expect((await me(cookie)).status).toBe(401); // the cookie that made the request can no longer be replayed
    expect((await me(second)).status).toBe(401);
    expect((await me(third)).status).toBe(401);
    expect((await me(fresh)).status).toBe(200);
    const header = setCookieHeader(res)!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
  });

  it('another user’s sessions and password are untouched', async () => {
    const other = await registerUser(app);
    const otherId = userIdOf(other.res);
    const otherHash = await hashOf(otherId);
    await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(await hashOf(otherId)).toBe(otherHash);
    expect((await me(other.cookie)).status).toBe(200);
  });

  it('requires a session and the CSRF header; the current password is not accepted from another account’s session', async () => {
    expect((await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, client(app))).status).toBe(401);
    expect((await request(app).post('/api/account/password').set('Cookie', cookie).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(403);
    const other = await registerUser(app, { password: 'Another-Long-Pass-77' });
    const res = await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, client(app, other.cookie));
    expect(res.status).toBe(422); // their password is not ours; and the answer reveals nothing about any other account
  });

  it('two simultaneous changes: exactly one wins, the other is refused, and the account is consistent', async () => {
    const [a, b] = await Promise.all([
      change({ currentPassword: PASSWORD, newPassword: 'First-New-Password-1' }),
      change({ currentPassword: PASSWORD, newPassword: 'Second-New-Password-2' }),
    ]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    expect([a.status, b.status].filter((s) => s === 409 || s === 422)).toHaveLength(1);
    expect(await sessionCount()).toBe(1);
  });

  it('rolls back completely if the session swap fails: old password, old sessions and cookie all still work', async () => {
    const second = await loginCookie(app, email);
    const before = await hashOf();
    await pool.query(`CREATE OR REPLACE FUNCTION test_fail_session_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$`);
    await pool.query('CREATE TRIGGER test_fail_sessions_insert BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION test_fail_session_insert()');
    let res;
    try {
      res = await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS test_fail_sessions_insert ON sessions');
      await pool.query('DROP FUNCTION IF EXISTS test_fail_session_insert()');
    }
    expect(res.status).toBe(500);
    expect(await hashOf()).toBe(before);
    expect(await sessionCount()).toBe(2);
    expect((await me(cookie)).status).toBe(200);
    expect((await me(second)).status).toBe(200);
  });

  it('never logs passwords, hashes or session tokens', async () => {
    await change({ currentPassword: 'wrong-wrong-wrong', newPassword: NEW_PASSWORD });
    const res = await change({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    const text = captured.text();
    for (const secret of [PASSWORD, NEW_PASSWORD, 'wrong-wrong-wrong', await hashOf(), sessionCookie(res)!.split('=')[1]!, cookie.split('=')[1]!]) {
      expect(text.includes(secret), 'a secret appeared in the logs').toBe(false);
    }
    expect(captured.events().some((e) => e.event === 'password_changed')).toBe(true);
  });
});

const me = (c: string) => request(app).get('/api/auth/me').set('Cookie', c);

describe('password confirmation attempts are rate limited per user (failures only)', () => {
  const limited = createCtx({ rateLimit: { loginPerEmailMax: 3 } });
  afterAll(() => limited.pool.end());

  it('after 3 failures even the correct password is refused (429); successes never count', async () => {
    const reg = await registerUser(limited.app);
    const c = client(limited.app, reg.cookie);
    for (let i = 0; i < 3; i++) expect((await c.post('/api/account/password', { currentPassword: 'nope-nope-nope', newPassword: NEW_PASSWORD })).status).toBe(422);
    const blocked = await c.post('/api/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(blocked.status).toBe(429);
    expect((await c.del('/api/account', { password: PASSWORD, confirmEmail: reg.email })).status).toBe(429); // deletion shares the budget
    // another user is unaffected
    const other = await registerUser(limited.app);
    expect((await client(limited.app, other.cookie).post('/api/account/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
  });
});

// ───────────────────────────── account deletion ─────────────────────────────

const TABLES = ['user_preferences', 'sessions', 'subscriptions', 'payments', 'subscription_price_history', 'reminders', 'email_verification_tokens'] as const;
const FK_USER: Record<string, string> = {
  user_preferences: 'user_id', sessions: 'user_id', subscriptions: 'user_id', payments: 'user_id', subscription_price_history: 'user_id', reminders: 'user_id', email_verification_tokens: 'user_id',
};

/** Gives a user one of everything that can hang off an account. */
async function fill(ck: string, id: string) {
  const c = client(app, ck);
  const sub = await createSub(app, ck, { name: 'Netflix', nextBillingDate: '2030-02-01' });
  await c.post(`/api/subscriptions/${sub.id}/payments`, { amountMinor: 64900, paidOn: '2030-01-10', forBillingDate: '2030-02-01' });
  await c.patch(`/api/subscriptions/${sub.id}`, { amountMinor: 79900 }); // price history row
  await pool.query(
    "INSERT INTO email_verification_tokens (user_id, email, token_hash, expires_at, created_at) VALUES ($1, 'x@example.com', decode(md5(random()::text) || md5(random()::text), 'hex'), now() + interval '1 day', now())",
    [id],
  );
  await runSchedulerCycle(env); // reminders
  return sub;
}
const rowsOf = async (id: string) => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await count(t, `WHERE ${FK_USER[t]} = $1`, [id])] as const)));

describe('DELETE /api/account', () => {
  const del = (body: unknown, c = api) => c.del('/api/account', body);

  it('deletes the account and EVERY dependent row (actual cascade), clears the cookie and answers 204', async () => {
    await fill(cookie, userId);
    const before = await rowsOf(userId);
    for (const t of TABLES) expect(before[t], `${t} should have rows before`).toBeGreaterThan(0);
    const res = await del({ password: PASSWORD, confirmEmail: email });
    expect(res.status).toBe(204);
    expect(await count('users', 'WHERE id = $1', [userId])).toBe(0);
    expect(await rowsOf(userId)).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])));
    expect(setCookieHeader(res)).toMatch(/sc_sid=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it('afterwards the old cookie and the password are useless, and the email can register again', async () => {
    await del({ password: PASSWORD, confirmEmail: email });
    expect((await me(cookie)).status).toBe(401);
    expect((await request(app).post('/api/auth/login').set(CSRF).send({ email, password: PASSWORD })).status).toBe(401);
    expect((await request(app).post('/api/auth/register').set(CSRF).send({ email, password: PASSWORD, displayName: 'Again' })).status).toBe(201);
  });

  it('ALL other sessions are invalidated too', async () => {
    const second = await loginCookie(app, email);
    const third = await loginCookie(app, email);
    await del({ password: PASSWORD, confirmEmail: email });
    expect(await sessionCount()).toBe(0);
    for (const c of [cookie, second, third]) expect((await me(c)).status).toBe(401);
  });

  it('requires the right password: wrong or missing changes nothing', async () => {
    await fill(cookie, userId);
    const before = await rowsOf(userId);
    const wrong = await del({ password: 'not-my-password', confirmEmail: email });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.details).toEqual([{ path: 'password', message: 'Your password is incorrect.' }]);
    expect((await del({ confirmEmail: email })).status).toBe(422);
    expect(await rowsOf(userId)).toEqual(before);
    expect((await me(cookie)).status).toBe(200);
  });

  it('requires the account email as explicit confirmation (case-insensitive); another address is refused', async () => {
    const other = await registerUser(app);
    const wrong = await del({ password: PASSWORD, confirmEmail: other.email });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.details[0].path).toBe('confirmEmail');
    expect((await del({ password: PASSWORD })).status).toBe(422);
    expect(await count('users', 'WHERE id = $1', [userId])).toBe(1);
    expect((await del({ password: PASSWORD, confirmEmail: email.toUpperCase() })).status).toBe(204);
  });

  it('rejects unknown keys and a missing body', async () => {
    expect((await del({ password: PASSWORD, confirmEmail: email, userId: 'x' })).status).toBe(422);
    expect((await api.del('/api/account')).status).toBe(422);
    expect(await count('users', 'WHERE id = $1', [userId])).toBe(1);
  });

  it('CROSS-USER ISOLATION: another account and all its data survive untouched, and one user can never delete another', async () => {
    const other = await registerUser(app);
    const otherId = userIdOf(other.res);
    await fill(other.cookie, otherId);
    await fill(cookie, userId);
    const otherBefore = await rowsOf(otherId);
    const otherSubs = (await pool.query('SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY id', [otherId])).rows;
    // using my session with THEIR email does not touch them
    expect((await del({ password: PASSWORD, confirmEmail: other.email })).status).toBe(422);
    expect(await rowsOf(otherId)).toEqual(otherBefore);
    expect((await del({ password: PASSWORD, confirmEmail: email })).status).toBe(204);
    expect(await rowsOf(otherId)).toEqual(otherBefore);
    expect((await pool.query('SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY id', [otherId])).rows).toEqual(otherSubs);
    expect((await me(other.cookie)).status).toBe(200);
  });

  it('ROLLBACK: if any dependent delete fails, nothing is deleted and the user stays signed in', async () => {
    await fill(cookie, userId);
    const second = await loginCookie(app, email);
    const before = await rowsOf(userId);
    const res = await withFailingTrigger(pool, 'payments', 'DELETE', () => del({ password: PASSWORD, confirmEmail: email }));
    expect(res.status).toBe(500);
    expect(await count('users', 'WHERE id = $1', [userId])).toBe(1);
    expect(await rowsOf(userId)).toEqual(before);
    expect((await me(cookie)).status).toBe(200);
    expect((await me(second)).status).toBe(200);
    // and once the fault is gone the same request succeeds
    expect((await del({ password: PASSWORD, confirmEmail: email })).status).toBe(204);
    expect(await count('subscriptions')).toBe(0);
  });

  it('requires a session and the CSRF header', async () => {
    expect((await del({ password: PASSWORD, confirmEmail: email }, client(app))).status).toBe(401);
    const noCsrf = await request(app).delete('/api/account').set('Cookie', cookie).send({ password: PASSWORD, confirmEmail: email });
    expect(noCsrf.status).toBe(403);
    expect(await count('users', 'WHERE id = $1', [userId])).toBe(1);
  });

  it('logs the event with the user id only: no password, email, hash or token', async () => {
    const hash = await hashOf();
    await del({ password: PASSWORD, confirmEmail: email });
    const text = captured.text();
    for (const secret of [PASSWORD, hash, email, cookie.split('=')[1]!]) expect(text.includes(secret), 'secret in logs').toBe(false);
    expect(captured.events().find((e) => e.event === 'account_deleted')).toMatchObject({ userId });
  });

  it('a reminder delivery racing the deletion cannot resurrect or fail loudly', async () => {
    await fill(cookie, userId);
    await setPrefs(pool, userId, { reminder_lead_days: 60 });
    clock.set('2030-02-01T00:00:00Z');
    cookie = await loginCookie(app, email); // the 17-day-old session has expired
    api = client(app, cookie);
    await del({ password: PASSWORD, confirmEmail: email });
    const result = await runSchedulerCycle(env);
    expect(result.failedTasks).toEqual([]);
    expect(await count('reminders')).toBe(0);
  });
});
