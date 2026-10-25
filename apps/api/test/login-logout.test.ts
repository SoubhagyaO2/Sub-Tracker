import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF, PASSWORD, createCtx, me, registerUser, resetDb, sessionCookie, setCookieHeader, uniqueEmail } from './helpers.js';

const ctx = createCtx();
const { app, pool } = ctx;

beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

const login = (email: string, password: string, cookie?: string, a = app) => {
  const r = request(a).post('/api/auth/login').set(CSRF);
  if (cookie) r.set('Cookie', cookie);
  return r.send({ email, password });
};

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials and issues a fresh session', async () => {
    const { email, cookie: registerCookie } = await registerUser(app);
    const res = await login(email, PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(email);
    const cookie = sessionCookie(res)!;
    expect(cookie).not.toBe(registerCookie);
    expect((await me(app, cookie)).status).toBe(200);
    expect((await me(app, registerCookie)).status).toBe(200); // other devices keep their own sessions
  });

  it('is case-insensitive on email', async () => {
    const { email } = await registerUser(app, { email: 'MixedCase@Example.com' });
    expect(email).toBe('MixedCase@Example.com'); // as typed
    expect((await login('MIXEDCASE@example.com', PASSWORD)).status).toBe(200);
  });

  it('gives an identical response for a wrong password and an unknown email', async () => {
    const { email } = await registerUser(app);
    const wrongPw = await login(email, 'definitely-wrong-password');
    const unknown = await login('nobody@example.com', 'definitely-wrong-password');
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrongPw.body);
    expect(wrongPw.body.error.code).toBe('UNAUTHENTICATED');
    expect(sessionCookie(wrongPw)).toBeUndefined();
    expect(sessionCookie(unknown)).toBeUndefined();
  });

  it('rejects malformed input and unknown keys', async () => {
    expect((await login('not-an-email', 'x')).status).toBe(422);
    expect((await login('a@example.com', '')).status).toBe(422);
    const res = await request(app).post('/api/auth/login').set(CSRF).send({ email: 'a@example.com', password: 'x', userId: 'abc' });
    expect(res.status).toBe(422);
    expect((await request(app).post('/api/auth/login').set(CSRF)).status).toBe(422);
  });

  it('rotates the session: logging in while holding a session invalidates the presented token', async () => {
    const { email, cookie: old } = await registerUser(app);
    const res = await login(email, PASSWORD, old);
    expect(res.status).toBe(200);
    expect((await me(app, old)).status).toBe(401);
    expect((await me(app, sessionCookie(res))).status).toBe(200);
  });

  it('transparently upgrades a password hash created with weaker parameters', async () => {
    const email = uniqueEmail();
    const weak = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 8, timeCost: 1, parallelism: 1 });
    await pool.query('INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)', [email, weak, 'W']);
    const id = (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
    await pool.query('INSERT INTO user_preferences (user_id) VALUES ($1)', [id]);

    expect((await login(email, PASSWORD)).status).toBe(200);
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [id]);
    expect(rows[0].password_hash).not.toBe(weak);
    expect(rows[0].password_hash).toContain('m=19456');
    expect((await login(email, PASSWORD)).status).toBe(200);
  });

  it('survives a corrupted stored hash without crashing or authenticating', async () => {
    const email = uniqueEmail();
    await pool.query('INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)', [email, 'not-a-real-hash', 'X']);
    const res = await login(email, PASSWORD);
    expect(res.status).toBe(401);
  });
});

describe('login throttling', () => {
  it('limits failed attempts per account (email), independent of IP, without locking out successes', async () => {
    const limited = createCtx({ rateLimit: { loginPerEmailMax: 3 } });
    try {
      const { email } = await registerUser(limited.app);
      for (let i = 0; i < 3; i++) expect((await login(email, 'wrong-password-1', undefined, limited.app)).status).toBe(401);
      const blocked = await login(email, PASSWORD, undefined, limited.app);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      // A different account is unaffected.
      const other = await registerUser(limited.app);
      expect((await login(other.email, PASSWORD, undefined, limited.app)).status).toBe(200);
    } finally {
      await limited.pool.end();
    }
  });

  it('does not count successful logins against the per-account limit', async () => {
    const limited = createCtx({ rateLimit: { loginPerEmailMax: 2 } });
    try {
      const { email } = await registerUser(limited.app);
      for (let i = 0; i < 6; i++) expect((await login(email, PASSWORD, undefined, limited.app)).status).toBe(200);
    } finally {
      await limited.pool.end();
    }
  });

  it('limits auth endpoints per IP', async () => {
    const limited = createCtx({ rateLimit: { authMax: 3 } });
    try {
      for (let i = 0; i < 3; i++) await login('x@example.com', 'whatever-password', undefined, limited.app);
      const res = await login('x@example.com', 'whatever-password', undefined, limited.app);
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.pool.end();
    }
  });
});

describe('POST /api/auth/logout', () => {
  it('ends the session server-side and clears the cookie', async () => {
    const { cookie } = await registerUser(app);
    const res = await request(app).post('/api/auth/logout').set(CSRF).set('Cookie', cookie);
    expect(res.status).toBe(204);
    expect(setCookieHeader(res)).toMatch(/^sc_sid=;.*Expires=Thu, 01 Jan 1970/);
    expect((await me(app, cookie)).status).toBe(401); // the old token is dead even if replayed
    expect((await pool.query('SELECT count(*)::int n FROM sessions')).rows[0].n).toBe(0);
  });

  it('only ends the current session, not the same user’s other sessions', async () => {
    const { email, cookie: a } = await registerUser(app);
    const b = sessionCookie(await login(email, PASSWORD))!;
    await request(app).post('/api/auth/logout').set(CSRF).set('Cookie', a).expect(204);
    expect((await me(app, a)).status).toBe(401);
    expect((await me(app, b)).status).toBe(200);
  });

  it('is idempotent without a session', async () => {
    expect((await request(app).post('/api/auth/logout').set(CSRF)).status).toBe(204);
    expect((await request(app).post('/api/auth/logout').set(CSRF).set('Cookie', 'sc_sid=garbage')).status).toBe(204);
  });

  it('requires the CSRF header', async () => {
    const { cookie } = await registerUser(app);
    const res = await request(app).post('/api/auth/logout').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect((await me(app, cookie)).status).toBe(200); // still logged in
  });
});
