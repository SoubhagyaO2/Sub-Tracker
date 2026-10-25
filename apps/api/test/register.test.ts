import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF, DAY, PASSWORD, T0, createCtx, me, registerUser, resetDb, sessionCookie, setCookieHeader, uniqueEmail } from './helpers.js';

const ctx = createCtx();
const { app, pool } = ctx;

beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

const post = (body: unknown) => request(app).post('/api/auth/register').set(CSRF).send(body as object);

describe('POST /api/auth/register', () => {
  it('creates the account, preferences and a session, and never returns secrets', async () => {
    const email = uniqueEmail();
    const res = await post({ email, password: PASSWORD, displayName: 'Asha' });

    expect(res.status).toBe(201);
    expect(res.body.data.user).toEqual({ id: expect.any(String), email, displayName: 'Asha', emailVerified: false });
    expect(res.body.data.preferences).toMatchObject({ currency: 'INR', theme: 'dark', timezone: 'Asia/Kolkata', reminderLeadDays: 3 });
    expect(res.body.data.features).toEqual({ emailVerificationAvailable: false });
    expect(JSON.stringify(res.body)).not.toMatch(/password|argon2|hash/i);

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE email = $1', [email]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
  });

  it('sets a hardened, persistent session cookie expiring at the absolute expiry', async () => {
    const res = await post({ email: uniqueEmail(), password: PASSWORD, displayName: 'A' });
    const header = setCookieHeader(res)!;
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; SameSite=Lax/);
    expect(header).toMatch(/; Path=\//);
    expect(header).not.toMatch(/; Secure/); // non-production only
    const expires = /Expires=([^;]+)/.exec(header)![1]!;
    expect(new Date(expires).getTime()).toBe(new Date(T0).getTime() + 30 * DAY);
  });

  it('stores only a SHA-256 hash of the session token', async () => {
    const res = await post({ email: uniqueEmail(), password: PASSWORD, displayName: 'A' });
    const token = sessionCookie(res)!.split('=')[1]!;
    const { rows } = await pool.query('SELECT token_hash FROM sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash.equals(createHash('sha256').update(token).digest())).toBe(true);
    expect(rows[0].token_hash.toString('utf8')).not.toContain(token);
  });

  it('normalizes email and rejects duplicates regardless of case, leaving no orphan rows', async () => {
    await post({ email: '  Case.User@Example.COM ', password: PASSWORD, displayName: 'A' }).expect(201);
    const { rows } = await pool.query('SELECT email FROM users');
    expect(rows).toEqual([{ email: 'case.user@example.com' }]);

    const dup = await post({ email: 'CASE.user@example.com', password: PASSWORD, displayName: 'B' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');

    const counts = await pool.query(
      'SELECT (SELECT count(*) FROM users)::int u, (SELECT count(*) FROM user_preferences)::int p, (SELECT count(*) FROM sessions)::int s',
    );
    expect(counts.rows[0]).toEqual({ u: 1, p: 1, s: 1 });
  });

  it('stores a valid timezone preference and rejects an unknown one', async () => {
    const ok = await post({ email: uniqueEmail(), password: PASSWORD, displayName: 'A', timezone: 'America/New_York' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.preferences.timezone).toBe('America/New_York');

    const bad = await post({ email: uniqueEmail(), password: PASSWORD, displayName: 'A', timezone: 'Mars/Olympus' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].path).toBe('timezone');
  });

  const invalid: [string, Record<string, unknown>, string][] = [
    ['short password', { password: 'short' }, 'password'],
    ['129-char password', { password: 'a'.repeat(129) }, 'password'],
    ['non-string password', { password: 12345678901 }, 'password'],
    ['bad email', { email: 'not-an-email' }, 'email'],
    ['email too long', { email: `${'a'.repeat(250)}@example.com` }, 'email'],
    ['empty display name', { displayName: '   ' }, 'displayName'],
    ['display name too long', { displayName: 'x'.repeat(81) }, 'displayName'],
    ['common password', { password: 'password123' }, 'password'],
    ['password containing email local part', { email: 'johnsmith@example.com', password: 'xxjohnsmithxx!!' }, 'password'],
  ];
  it.each(invalid)('rejects %s with a field-level 422', async (_name, patch, path) => {
    const res = await post({ email: uniqueEmail(), password: PASSWORD, displayName: 'A', ...patch });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
    expect(rows[0].n).toBe(0);
  });

  it('rejects unknown keys so clients cannot inject columns such as id or email_verified_at', async () => {
    for (const extra of [{ id: '00000000-0000-0000-0000-000000000001' }, { emailVerifiedAt: '2020-01-01' }, { isAdmin: true }]) {
      const res = await post({ email: uniqueEmail(), password: PASSWORD, displayName: 'A', ...extra });
      expect(res.status).toBe(422);
    }
    expect((await pool.query('SELECT count(*)::int n FROM users')).rows[0].n).toBe(0);
  });

  it('rejects missing, array and null bodies', async () => {
    expect((await request(app).post('/api/auth/register').set(CSRF)).status).toBe(422);
    expect((await post([])).status).toBe(422);
    expect((await post(null)).status).toBe(422);
  });

  it('returns 400 for malformed JSON and 413 for oversized bodies, with the standard envelope', async () => {
    const malformed = await request(app).post('/api/auth/register').set(CSRF).set('Content-Type', 'application/json').send('{"email": ');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: { code: 'MALFORMED_REQUEST', message: expect.any(String) } });

    const big = await post({ email: uniqueEmail(), password: PASSWORD, displayName: 'x'.repeat(200_000) });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('does not leak internals in error responses', async () => {
    const res = await request(app).post('/api/auth/register').set(CSRF).set('Content-Type', 'application/json').send('{bad');
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+|node_modules|SyntaxError|Unexpected/);
  });

  it('logs the new user in: the returned cookie authenticates /me', async () => {
    const { cookie, email } = await registerUser(app);
    const res = await me(app, cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(email);
  });

  it('rotates away a pre-existing session on this browser', async () => {
    const first = await registerUser(app);
    const second = await request(app)
      .post('/api/auth/register')
      .set(CSRF)
      .set('Cookie', first.cookie)
      .send({ email: uniqueEmail(), password: PASSWORD, displayName: 'B' });
    expect(second.status).toBe(201);
    expect((await me(app, first.cookie)).status).toBe(401);
    expect((await me(app, sessionCookie(second))).status).toBe(200);
  });
});
