import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createResetToken, resetLink } from '../src/auth/passwordReset.js';
import {
  CSRF, DAY, FakeMailer, PASSWORD, T0, captureLogs, client, createCtx, loginCookie, me, registerUser, resetDb, userIdOf,
} from './helpers.js';

const NEW_PASSWORD = 'Correct-Horse-9-battery';
const HOUR = 60 * 60 * 1000;

const captured = captureLogs();
const mailer = new FakeMailer();
const ctx = createCtx({ mailer, logger: captured.logger });
const { app, pool, clock, config } = ctx;

let userId: string;
let email: string;
let cookie: string;

beforeEach(async () => {
  await resetDb(pool);
  clock.set(T0);
  Object.assign(mailer, { sent: [], errors: [], attempts: 0, configured: true, onSend: undefined, failNext: false });
  captured.lines.length = 0;
  const reg = await registerUser(app, { displayName: 'Ada Lovelace' });
  userId = userIdOf(reg.res);
  email = reg.email;
  cookie = reg.cookie;
});
afterAll(() => pool.end());

const requestReset = (body: unknown, a = app) => request(a).post('/api/auth/password-reset/request').set(CSRF).send(body as object);
const confirmReset = (body: unknown, a = app) => request(a).post('/api/auth/password-reset/confirm').set(CSRF).send(body as object);
const tokenRows = async (id = userId) => (await pool.query('SELECT * FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at', [id])).rows;
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest();

/** The send happens after the response (so timing cannot reveal whether the account exists): wait for it. */
async function waitForMails(n: number) {
  const until = Date.now() + 3000;
  while (mailer.sent.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  expect(mailer.sent.length).toBe(n);
}
const tokenFromMail = (i = 0) => {
  const m = /reset-password#token=([A-Za-z0-9_-]+)/.exec(mailer.sent[i]!.text);
  if (!m) throw new Error('no reset link in the email');
  return m[1]!;
};
async function issueToken(): Promise<string> {
  const before = mailer.sent.length;
  expect((await requestReset({ email })).status).toBe(202);
  await waitForMails(before + 1);
  return tokenFromMail(before);
}

describe('POST /api/auth/password-reset/request', () => {
  it('answers 202 with the same body for an existing and an unknown address, and mails only the existing one', async () => {
    const known = await requestReset({ email });
    const unknown = await requestReset({ email: 'nobody-here@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
    expect(known.body).toEqual({ data: { requested: true } });
    await waitForMails(1);
    expect(mailer.sent[0]!.to).toBe(email);
    expect(await tokenRows()).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM password_reset_tokens')).rows[0].n).toBe(1);
  });

  it('the email carries a link whose token is in the URL FRAGMENT, and only the hash of it is stored (32 bytes, one hour)', async () => {
    await requestReset({ email: email.toUpperCase() }); // addresses are normalised
    await waitForMails(1);
    const mail = mailer.sent[0]!;
    expect(mail.subject).toBe('Reset your SubCycle password');
    expect(mail.text).toContain('Ada Lovelace');
    expect(mail.text).toContain(`${config.appUrl}/reset-password#token=`);
    expect(mail.text).not.toMatch(/\?token=/); // never a query string: that would reach server and proxy logs
    const token = tokenFromMail();
    const [row] = await tokenRows();
    expect(Buffer.compare(row.token_hash, sha(token))).toBe(0);
    expect(row.token_hash).toHaveLength(32);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()).toBe(HOUR);
    expect(row.used_at).toBeNull();
  });

  it('a newer request invalidates the older link', async () => {
    const first = await issueToken();
    const second = await issueToken();
    expect(first).not.toBe(second);
    expect(await tokenRows()).toHaveLength(1);
    expect((await confirmReset({ token: first, newPassword: NEW_PASSWORD })).status).toBe(400);
    expect((await confirmReset({ token: second, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it('without an email provider it fails honestly with 503, identically for every address, and creates nothing', async () => {
    mailer.configured = false;
    const known = await requestReset({ email });
    const unknown = await requestReset({ email: 'nobody-here@example.com' });
    for (const res of [known, unknown]) {
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('EMAIL_NOT_CONFIGURED');
    }
    expect(unknown.body.error.message).toBe(known.body.error.message);
    expect(await tokenRows()).toHaveLength(0);
    expect(mailer.attempts).toBe(0);
  });

  it('a delivery failure is logged without the address or token, and the caller still gets the same 202', async () => {
    mailer.failNext = true;
    const res = await requestReset({ email });
    expect(res.status).toBe(202);
    const until = Date.now() + 3000;
    while (mailer.attempts < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    const logs = captured.text();
    expect(logs).toContain('password reset email delivery failed');
    expect(logs).not.toContain(email);
    const [row] = await tokenRows();
    expect(row).toBeDefined();
  });

  it('validates the body strictly and needs the CSRF header', async () => {
    expect((await requestReset({})).status).toBe(422);
    expect((await requestReset({ email: 'not-an-email' })).status).toBe(422);
    expect((await requestReset({ email, extra: 1 })).status).toBe(422);
    const noCsrf = await request(app).post('/api/auth/password-reset/request').send({ email });
    expect(noCsrf.status).toBe(403);
    expect(mailer.attempts).toBe(0);
  });

  it('is limited per address (counting unknown addresses too) and per client', async () => {
    const limited = createCtx({ mailer, rateLimit: { resetPerEmailMax: 3, authMax: 5 } });
    try {
      for (let i = 0; i < 3; i++) expect((await requestReset({ email: 'someone@example.com' }, limited.app)).status).toBe(202);
      const fourth = await requestReset({ email: 'someone@example.com' }, limited.app);
      expect(fourth.status).toBe(429);
      expect(fourth.body.error.code).toBe('RATE_LIMITED');
      // a different address is not affected by that one, until the per-client limit (5) is reached
      expect((await requestReset({ email: 'other@example.com' }, limited.app)).status).toBe(202);
      expect((await requestReset({ email: 'third@example.com' }, limited.app)).status).toBe(429);
    } finally {
      await limited.pool.end();
    }
  });
});

describe('POST /api/auth/password-reset/confirm', () => {
  it('sets the new password, signs the user out everywhere, deletes every reset token and signs nobody in', async () => {
    const otherDevice = await loginCookie(app, email);
    expect((await me(app, cookie)).status).toBe(200);
    expect((await me(app, otherDevice)).status).toBe(200);
    const token = await issueToken();

    const res = await confirmReset({ token, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { reset: true } });
    expect(res.headers['set-cookie']).toBeUndefined();

    expect((await me(app, cookie)).status).toBe(401);
    expect((await me(app, otherDevice)).status).toBe(401);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [userId])).rows[0].n).toBe(0);
    expect(await tokenRows()).toHaveLength(0);

    expect((await request(app).post('/api/auth/login').set(CSRF).send({ email, password: PASSWORD })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').set(CSRF).send({ email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('sends a "your password was changed" notice that contains no link or token', async () => {
    const token = await issueToken();
    await confirmReset({ token, newPassword: NEW_PASSWORD });
    await waitForMails(2);
    const notice = mailer.sent[1]!;
    expect(notice.to).toBe(email);
    expect(notice.subject).toBe('Your SubCycle password was changed');
    expect(notice.text).not.toContain(token);
    expect(notice.text).not.toMatch(/https?:\/\//);
  });

  it('a link works exactly once', async () => {
    const token = await issueToken();
    expect((await confirmReset({ token, newPassword: NEW_PASSWORD })).status).toBe(200);
    const again = await confirmReset({ token, newPassword: 'Another-Fine-Pass-7' });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_TOKEN');
    expect((await request(app).post('/api/auth/login').set(CSRF).send({ email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('a link is still valid one second before the hour is up', async () => {
    const token = await issueToken();
    clock.set(new Date(Date.parse(T0) + HOUR - 1000).toISOString());
    expect((await confirmReset({ token, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it('a link is refused once the hour is up, and the password stays unchanged', async () => {
    const token = await issueToken();
    clock.set(new Date(Date.parse(T0) + HOUR + 1000).toISOString());
    const expired = await confirmReset({ token, newPassword: NEW_PASSWORD });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('INVALID_TOKEN');
    expect((await request(app).post('/api/auth/login').set(CSRF).send({ email, password: PASSWORD })).status).toBe(200);
  });

  it('refuses unknown, malformed and missing tokens with the same message', async () => {
    const responses = [
      await confirmReset({ token: 'x'.repeat(43), newPassword: NEW_PASSWORD }),
      await confirmReset({ token: 'A'.repeat(43), newPassword: NEW_PASSWORD }),
    ];
    for (const r of responses) {
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_TOKEN');
    }
    expect(responses[1]!.body).toEqual(responses[0]!.body);
    expect((await confirmReset({ newPassword: NEW_PASSWORD })).status).toBe(422);
    expect((await confirmReset({ token: 'short', newPassword: NEW_PASSWORD })).status).toBe(422);
  });

  it('applies the registration password policy, and a refused password does not use up the link', async () => {
    const token = await issueToken();
    const tooShort = await confirmReset({ token, newPassword: 'short' });
    expect(tooShort.status).toBe(422);
    const common = await confirmReset({ token, newPassword: 'password1234' });
    expect(common.status).toBe(422);
    expect(common.body.error.details[0].path).toBe('newPassword'); // the field the reset form shows it against
    const containsEmail = await confirmReset({ token, newPassword: email });
    expect(containsEmail.status).toBe(422);
    expect(containsEmail.body.error.details[0].path).toBe('newPassword');
    expect(await tokenRows()).toHaveLength(1); // still usable
    expect((await request(app).post('/api/auth/login').set(CSRF).send({ email, password: PASSWORD })).status).toBe(200); // nothing changed
    expect((await confirmReset({ token, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it('only changes the account the token belongs to', async () => {
    const other = await registerUser(app);
    const token = await issueToken();
    await confirmReset({ token, newPassword: NEW_PASSWORD });
    expect((await me(app, other.cookie)).status).toBe(200); // someone else's session is untouched
    expect((await request(app).post('/api/auth/login').set(CSRF).send({ email: other.email, password: PASSWORD })).status).toBe(200);
  });

  it('never logs the token, the new password or the address', async () => {
    const token = await issueToken();
    await confirmReset({ token, newPassword: NEW_PASSWORD });
    await waitForMails(2);
    const logs = captured.text();
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(NEW_PASSWORD);
    expect(logs).not.toContain(email);
    expect(captured.events().some((e) => e.event === 'password_reset')).toBe(true);
  });

  it('works without an email provider (a link from the operator command needs no mail)', async () => {
    mailer.configured = false;
    const token = await createResetToken(pool, config, clock, userId);
    expect((await confirmReset({ token, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect(mailer.attempts).toBe(0); // no notice attempted either
    expect((await request(app).post('/api/auth/login').set(CSRF).send({ email, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('is limited per client', async () => {
    const limited = createCtx({ mailer, rateLimit: { authMax: 2 } });
    try {
      expect((await confirmReset({ token: 'A'.repeat(43), newPassword: NEW_PASSWORD }, limited.app)).status).toBe(400);
      expect((await confirmReset({ token: 'B'.repeat(43), newPassword: NEW_PASSWORD }, limited.app)).status).toBe(400);
      expect((await confirmReset({ token: 'C'.repeat(43), newPassword: NEW_PASSWORD }, limited.app)).status).toBe(429);
    } finally {
      await limited.pool.end();
    }
  });
});

describe('reset links created by the server', () => {
  it('createResetToken replaces older unused tokens, tidies long-expired ones and builds a fragment link', async () => {
    const a = await createResetToken(pool, config, clock, userId);
    const b = await createResetToken(pool, config, clock, userId);
    expect(a).not.toBe(b);
    expect(await tokenRows()).toHaveLength(1);
    expect(resetLink(config, b)).toBe(`${config.appUrl}/reset-password#token=${b}`);

    // a token that expired more than a day ago is removed by the next creation, for any user
    const other = await registerUser(app);
    await pool.query(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at) VALUES ($1, decode(md5('old') || md5('older'), 'hex'), $2, $2)",
      [userIdOf(other.res), new Date(Date.parse(T0) - 3 * DAY)],
    );
    expect((await pool.query('SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1', [userIdOf(other.res)])).rows[0].n).toBe(1);
    await createResetToken(pool, config, clock, userId);
    expect((await pool.query('SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1', [userIdOf(other.res)])).rows[0].n).toBe(0);
  });

  it('deleting the account deletes its reset tokens', async () => {
    await createResetToken(pool, config, clock, userId);
    const del = await client(app, cookie).del('/api/account', { password: PASSWORD, confirmEmail: email });
    expect(del.status).toBe(204);
    expect(await tokenRows()).toHaveLength(0);
  });
});
