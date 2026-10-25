import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { purgeExpiredSessions } from '../src/auth/sessions.js';
import { DAY, createCtx, me, registerUser, resetDb, setCookieHeader, uniqueEmail } from './helpers.js';

const ctx = createCtx();
const { app, pool, clock } = ctx;
const MIN = 60_000;

beforeEach(async () => {
  await resetDb(pool);
  clock.set('2030-01-15T10:00:00.000Z');
});
afterAll(() => pool.end());

const lastSeen = async () => (await pool.query('SELECT last_seen_at FROM sessions')).rows[0].last_seen_at as Date;

describe('GET /api/auth/me', () => {
  it('requires authentication and uses the standard error envelope', async () => {
    const res = await me(app);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: expect.any(String) } });
  });

  it('rejects garbage and oversized cookies, and clears them', async () => {
    const garbage = await me(app, 'sc_sid=not-a-real-token');
    expect(garbage.status).toBe(401);
    expect(setCookieHeader(garbage)).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await me(app, `sc_sid=${'a'.repeat(5000)}`)).status).toBe(401);
  });

  it('ignores any client-supplied user identity', async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const res = await me(app, a.cookie)
      .query({ userId: b.res.body.data.user.id })
      .set('X-User-Id', b.res.body.data.user.id);
    expect(res.body.data.user.email).toBe(a.email);
  });
});

describe('session expiry (deterministic clock)', () => {
  it('idle expiry: valid just before 14 days of inactivity, dead at exactly 14 days', async () => {
    const { cookie } = await registerUser(app);
    clock.advance(14 * DAY - 1000);
    expect((await me(app, cookie)).status).toBe(200);

    // That request slid the idle window. Start over to test the exact boundary without touching it.
    await resetDb(pool);
    clock.set('2030-01-15T10:00:00.000Z');
    const second = await registerUser(app);
    clock.advance(14 * DAY);
    const expired = await me(app, second.cookie);
    expect(expired.status).toBe(401);
    expect(setCookieHeader(expired)).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('idle expiry slides with activity', async () => {
    const { cookie } = await registerUser(app);
    clock.advance(10 * DAY);
    expect((await me(app, cookie)).status).toBe(200);
    clock.advance(10 * DAY); // 20 days since login, only 10 since last activity
    expect((await me(app, cookie)).status).toBe(200);
  });

  it('absolute expiry: an always-active session still dies 30 days after login', async () => {
    const { cookie } = await registerUser(app);
    for (let day = 10; day <= 29; day += 10) {
      clock.set(new Date(Date.parse('2030-01-15T10:00:00.000Z') + day * DAY));
      expect((await me(app, cookie)).status).toBe(200);
    }
    clock.set(new Date(Date.parse('2030-01-15T10:00:00.000Z') + 30 * DAY - 1000));
    expect((await me(app, cookie)).status).toBe(200);
    clock.set(new Date(Date.parse('2030-01-15T10:00:00.000Z') + 30 * DAY));
    expect((await me(app, cookie)).status).toBe(401);
  });

  it('refreshes last_seen at most once per 5 minutes', async () => {
    const { cookie } = await registerUser(app);
    const t0 = await lastSeen();
    clock.advance(4 * MIN + 59_000);
    await me(app, cookie);
    expect((await lastSeen()).getTime()).toBe(t0.getTime());
    clock.advance(1000);
    await me(app, cookie);
    expect((await lastSeen()).getTime()).toBe(t0.getTime() + 5 * MIN);
  });

  it('purgeExpiredSessions removes only sessions that can no longer authenticate', async () => {
    const stale = await registerUser(app);
    clock.advance(20 * DAY);
    const fresh = await registerUser(app, { email: uniqueEmail() });
    expect(await purgeExpiredSessions(pool, clock)).toBe(1);
    expect((await me(app, fresh.cookie)).status).toBe(200);
    expect((await me(app, stale.cookie)).status).toBe(401);
  });

  it('issues 256-bit base64url session tokens', async () => {
    const a = await registerUser(app);
    expect(a.cookie).toMatch(/^sc_sid=[A-Za-z0-9_-]{43}$/);
  });
});
