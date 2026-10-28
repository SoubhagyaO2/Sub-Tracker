import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { describeError } from '../src/errorLog.js';
import { FakeMailer, PASSWORD, T0, captureLogs, client, createCtx, registerUser, resetDb, smtpError, uniqueEmail } from './helpers.js';
import { CSRF } from './helpers.js';

const PROD = { NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com', APP_URL: 'https://app.example.com' };
const ORIGIN = 'https://app.example.com';

// Values that must never reach a client or a log. They are deliberately shaped like the real leak sources.
const SECRET_EMAIL = 'victim.person@example.com';
const SECRET_VALUE = 'leaky-value-4eC39HqLyjWDarjtT1zdp7dc';
const SECRET_NOTE = 'my-private-note-about-therapy';

/** The error a driver would raise for a unique violation: its message, detail, where and parameters all quote data. */
const pgUniqueViolation = () =>
  Object.assign(new Error(`duplicate key value violates unique constraint "users_email_key" -- Key (email)=(${SECRET_EMAIL}) already exists`), {
    name: 'error',
    code: '23505',
    severity: 'ERROR',
    detail: `Key (email)=(${SECRET_EMAIL}) already exists.`,
    hint: `try another value than ${SECRET_VALUE}`,
    where: `SQL statement "INSERT ... VALUES (${SECRET_VALUE})"`,
    parameters: [SECRET_EMAIL, SECRET_VALUE],
    schema: 'public',
    table: 'users',
    constraint: 'users_email_key',
  });

const captured = captureLogs();
const mailer = new FakeMailer();
const ctx = createCtx({ mailer, logger: captured.logger, env: PROD });
const { pool, clock, config } = ctx;

beforeEach(async () => {
  await resetDb(pool);
  captured.lines.length = 0;
  clock.set(T0);
  Object.assign(mailer, { sent: [], errors: [], attempts: 0, configured: true });
});
afterAll(() => pool.end());

/** An app whose pool fails (with a data-bearing error) for queries matching `when`, and is real otherwise. */
function appFailingOn(when: RegExp, error: () => Error) {
  const wrapped = new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') return (sql: unknown, ...rest: unknown[]) => (typeof sql === 'string' && when.test(sql) ? Promise.reject(error()) : (target.query as (...a: unknown[]) => unknown)(sql, ...rest));
      return Reflect.get(target, prop, receiver);
    },
  });
  return createApp({ config, pool: wrapped, clock, mailer, logger: captured.logger });
}

const leaks = (text: string) => [SECRET_EMAIL, SECRET_VALUE, SECRET_NOTE, PASSWORD, 'duplicate key', 'Key (email)'].filter((s) => text.includes(s));

describe('5xx responses: generic, with a request id, never the cause', () => {
  it('a database error that quotes row values: the client gets only a generic message and the request id', async () => {
    const reg = await registerUser(ctx.app, {}, ORIGIN);
    const app = appFailingOn(/FROM subscriptions/, pgUniqueViolation);
    const res = await request(app).get('/api/subscriptions').set('Cookie', reg.cookie);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.', requestId: res.headers['x-request-id'] } });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(leaks(JSON.stringify(res.body) + JSON.stringify(res.headers))).toEqual([]);
  });

  it('the log line for that failure has the request id, status and SQLSTATE, and none of the quoted values', async () => {
    const reg = await registerUser(ctx.app, {}, ORIGIN);
    captured.lines.length = 0;
    const res = await request(appFailingOn(/FROM subscriptions/, pgUniqueViolation)).get('/api/subscriptions').set('Cookie', reg.cookie);
    const all = captured.text();
    expect(leaks(all)).toEqual([]);
    expect(all).not.toMatch(/Key \(|already exists|INSERT \.\.\.|VALUES/);
    const failed = captured.events().find((e) => e.event === 'request_failed') as Record<string, unknown>;
    expect(failed).toBeDefined();
    expect(failed.status).toBe(500);
    expect(failed.err).toMatchObject({ errorName: 'error', errorCode: '23505', constraint: 'users_email_key', table: 'users' });
    expect(Object.keys(failed.err as object).sort()).toEqual(['constraint', 'errorCode', 'errorName', 'frames', 'table']);
    // The same request id is in the HTTP response, the request-failed event and the access log, so the two can be matched.
    const withId = captured.events().filter((e) => (e.req as { id?: string } | undefined)?.id === res.headers['x-request-id']);
    expect(withId.length).toBeGreaterThan(0);
  });

  it('a real PostgreSQL error raised with sensitive text (message and DETAIL) is sanitized the same way', async () => {
    const reg = await registerUser(ctx.app, {}, ORIGIN);
    captured.lines.length = 0;
    await pool.query(
      `CREATE OR REPLACE FUNCTION test_leaky_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom for ${SECRET_EMAIL}' USING DETAIL = 'token ${SECRET_VALUE}', HINT = '${SECRET_NOTE}'; END $$`,
    );
    await pool.query('CREATE TRIGGER test_leaky_trigger BEFORE INSERT ON subscriptions FOR EACH ROW EXECUTE FUNCTION test_leaky_failure()');
    let res: request.Response;
    try {
      res = await client(ctx.app, reg.cookie).post('/api/subscriptions', { name: 'Netflix', amountMinor: 100, billingFrequency: 'monthly', nextBillingDate: '2030-02-01', notes: SECRET_NOTE });
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS test_leaky_trigger ON subscriptions');
      await pool.query('DROP FUNCTION IF EXISTS test_leaky_failure()');
    }
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR', requestId: res.headers['x-request-id'] });
    expect(leaks(JSON.stringify(res.body))).toEqual([]);
    expect(leaks(captured.text())).toEqual([]);
    expect(captured.text()).not.toContain('boom for');
    expect((captured.events().find((e) => e.event === 'request_failed') as { err: { errorCode: string } }).err.errorCode).toBe('P0001');
  });

  it('a failing login never logs the submitted password or email, and never reveals why it failed', async () => {
    const email = uniqueEmail();
    await registerUser(ctx.app, { email }, ORIGIN);
    captured.lines.length = 0;
    const app = appFailingOn(/FROM users WHERE lower\(email\)/, pgUniqueViolation);
    const res = await request(app).post('/api/auth/login').set(CSRF).set('Origin', ORIGIN).send({ email, password: PASSWORD });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    const text = captured.text();
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(email);
    expect(leaks(text)).toEqual([]);
  });

  it('a failing email send: the client sees a fixed message; the log has the SMTP code but not the recipient or provider text', async () => {
    const reg = await registerUser(ctx.app, {}, ORIGIN);
    captured.lines.length = 0;
    mailer.errors = [smtpError(550)]; // message includes "secret-provider-text user@example.com"
    const res = await client(ctx.app, reg.cookie).post('/api/account/email-verification');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: 'EMAIL_SEND_FAILED', requestId: res.headers['x-request-id'] });
    const all = JSON.stringify(res.body) + captured.text();
    expect(all).not.toContain('secret-provider-text');
    expect(all).not.toContain('user@example.com');
    expect(all).not.toContain(reg.email);
    const logged = captured.events().find((e) => (e.err as { errorCode?: number } | undefined)?.errorCode === 550);
    expect(logged).toBeDefined();
  });

  it('the same sanitised response is produced in development (no detail is ever added by environment)', async () => {
    const dev = createCtx({ logger: captured.logger });
    try {
      const reg = await registerUser(dev.app);
      const wrapped = new Proxy(dev.pool, {
        get: (t, p, r) => (p === 'query' ? (sql: unknown, ...a: unknown[]) => (typeof sql === 'string' && /FROM subscriptions/.test(sql) ? Promise.reject(pgUniqueViolation()) : (t.query as (...x: unknown[]) => unknown)(sql, ...a)) : Reflect.get(t, p, r)),
      });
      const app = createApp({ config: dev.config, pool: wrapped, clock: dev.clock, mailer: dev.mailer, logger: captured.logger });
      const res = await request(app).get('/api/subscriptions').set('Cookie', reg.cookie);
      expect(res.status).toBe(500);
      expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message', 'requestId']);
      expect(leaks(JSON.stringify(res.body))).toEqual([]);
    } finally {
      await dev.pool.end();
    }
  });
});

describe('expected client errors keep their status codes and contracts', () => {
  it('400, 401, 403, 404, 409, 413 and 422 are unchanged and carry no request id', async () => {
    const reg = await registerUser(ctx.app, {}, ORIGIN);
    const api = client(ctx.app, reg.cookie);

    const malformed = await request(ctx.app).post('/api/auth/login').set(CSRF).set('Origin', ORIGIN).set('Content-Type', 'application/json').send('{"email": ');
    expect([malformed.status, malformed.body]).toEqual([400, { error: { code: 'MALFORMED_REQUEST', message: 'The request body could not be read.' } }]);

    const unauth = await client(ctx.app).get('/api/subscriptions');
    expect([unauth.status, unauth.body.error.code]).toEqual([401, 'UNAUTHENTICATED']);

    const csrf = await request(ctx.app).post('/api/auth/logout');
    expect([csrf.status, csrf.body]).toEqual([403, { error: { code: 'CSRF_REJECTED', message: 'Request rejected.' } }]);

    const missing = await api.get('/api/subscriptions/00000000-0000-4000-8000-000000000000');
    expect([missing.status, missing.body]).toEqual([404, { error: { code: 'NOT_FOUND', message: expect.any(String) } }]);

    const dup = await request(ctx.app).post('/api/auth/register').set(CSRF).set('Origin', ORIGIN).send({ email: reg.email, password: PASSWORD, displayName: 'Again' });
    expect([dup.status, dup.body.error.code]).toEqual([409, 'EMAIL_TAKEN']);

    const invalid = await api.post('/api/subscriptions', { name: '', amountMinor: -1 });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Please check the highlighted fields.' });
    expect(Array.isArray(invalid.body.error.details)).toBe(true);

    const big = await request(ctx.app).post('/api/auth/login').set(CSRF).set('Origin', ORIGIN).set('Content-Type', 'application/json').send(JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(200_000) }));
    expect([big.status, big.body.error.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);

    for (const r of [malformed, unauth, csrf, missing, dup, invalid, big]) expect(r.body.error.requestId).toBeUndefined();
    expect(captured.events().some((e) => e.event === 'request_failed')).toBe(false); // client errors are not logged as failures
  });

  it('validation errors do not echo submitted values', async () => {
    const reg = await registerUser(ctx.app, {}, ORIGIN);
    const res = await client(ctx.app, reg.cookie).post('/api/subscriptions', { name: 'ok', amountMinor: 100, billingFrequency: 'monthly', nextBillingDate: '2030-02-01', notes: SECRET_NOTE, category: SECRET_VALUE });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_VALUE);
  });
});

describe('describeError (what a log line may contain about an error)', () => {
  it('keeps only class, code and schema identifiers, plus stack frames without the message line', () => {
    const e = pgUniqueViolation();
    const out = describeError(e);
    expect(Object.keys(out).sort()).toEqual(['constraint', 'errorCode', 'errorName', 'frames', 'table']);
    expect(JSON.stringify(out)).not.toMatch(/Key \(|victim|leaky-value|duplicate/);
    expect(out.frames!.every((f) => f.startsWith('at '))).toBe(true);
  });
  it('rejects identifier fields that are not plain identifiers (no data smuggled through "constraint" or "name")', () => {
    const out = describeError(Object.assign(new Error('x'), { name: `Err ${SECRET_EMAIL}`, code: `C ${SECRET_VALUE}`, constraint: `(${SECRET_EMAIL})`, table: 'ok_table' }));
    expect(JSON.stringify(out)).not.toMatch(/victim|leaky-value/);
    expect(out).toMatchObject({ errorName: 'Error', table: 'ok_table' });
  });
  it('handles non-errors', () => {
    expect(describeError(null)).toEqual({ errorName: 'object' });
    expect(describeError(`string with ${SECRET_VALUE}`)).toEqual({ errorName: 'string' });
    expect(describeError(undefined)).toEqual({ errorName: 'undefined' });
    expect(describeError({ responseCode: 421 })).toMatchObject({ errorCode: 421 });
  });
});
