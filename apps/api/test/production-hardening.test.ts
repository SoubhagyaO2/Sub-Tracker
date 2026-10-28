import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { FakeClock } from '../src/clock.js';
import { createPool } from '../src/db/pool.js';
import { DisabledMailer } from '../src/mail/mailer.js';
import { TEST_DB_URL } from './dbUrl.js';
import { CSRF, PASSWORD, resetDb, sessionCookie, setCookieHeader, T0, uniqueEmail } from './helpers.js';

const PROD_DB = 'postgres://app_user:g3n3rated-Secret@db.internal:5432/subcycle?sslmode=require';
const prod = (over: Record<string, string> = {}) => ({
  NODE_ENV: 'production', DATABASE_URL: PROD_DB, CORS_ORIGINS: 'https://app.example.com', APP_URL: 'https://app.example.com', TRUST_PROXY: '1', ...over,
});

describe('production configuration rejects unsafe defaults', () => {
  it('accepts a sound production configuration without warnings', () => {
    const c = loadConfig(prod());
    expect(c.isProd).toBe(true);
    expect(c.warnings).toEqual([]);
    expect(c.session.cookieName).toBe('__Host-sc_sid');
  });

  it.each<[string, Record<string, string>, RegExp]>([
    ['the development database credentials', { DATABASE_URL: 'postgres://subcycle:subcycle@db.internal:5432/subcycle?sslmode=require' }, /development credentials/],
    ['a database URL without a password', { DATABASE_URL: 'postgres://app_user@db.internal:5432/subcycle' }, /password/],
    ['a non-URL database setting', { DATABASE_URL: 'not a url' }, /DATABASE_URL/],
    ['an http APP_URL', { APP_URL: 'http://app.example.com' }, /https/],
    ['an http CORS origin', { CORS_ORIGINS: 'http://app.example.com' }, /https/],
    ['a wildcard CORS origin', { CORS_ORIGINS: '*' }, /Invalid CORS origin/],
    ['no CORS origins', { CORS_ORIGINS: '' }, /CORS_ORIGINS/],
    ['localhost as the public URL', { APP_URL: 'https://localhost:5173', CORS_ORIGINS: 'https://app.example.com' }, /points at this machine/],
    ['localhost as a CORS origin', { CORS_ORIGINS: 'https://127.0.0.1:5173' }, /points at this machine/],
    ['a partial SMTP configuration', { SMTP_HOST: 'smtp.example.com' }, /partially configured/],
    ['an invalid TRUST_PROXY', { TRUST_PROXY: 'yes' }, /TRUST_PROXY/],
  ])('refuses %s', (_label, over, message) => {
    expect(() => loadConfig(prod(over))).toThrow(message);
  });

  it('allowed-but-risky settings produce a start-up warning instead of silence', () => {
    const w = loadConfig(prod({ TRUST_PROXY: 'false', LOG_LEVEL: 'debug', DATABASE_URL: 'postgres://app_user:g3n3rated-Secret@db.internal:5432/subcycle' })).warnings.join(' | ');
    expect(w).toMatch(/TRUST_PROXY is false/);
    expect(w).toMatch(/does not require TLS/);
    expect(w).toMatch(/LOG_LEVEL=debug/);
    expect(loadConfig(prod({ DATABASE_URL: `${PROD_DB.split('?')[0]}?sslmode=disable` })).warnings.join()).toMatch(/does not require TLS/);
  });

  it('warnings never contain the database password', () => {
    const w = loadConfig(prod({ TRUST_PROXY: 'false', DATABASE_URL: 'postgres://app_user:g3n3rated-Secret@db.internal/subcycle' })).warnings.join();
    expect(w).not.toContain('g3n3rated-Secret');
  });

  it('development is not subject to the production rules (local http and dev credentials still work)', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://subcycle:subcycle@localhost:5434/subcycle' })).not.toThrow();
  });
});

describe('no development-only behaviour can be switched on', () => {
  const root = path.resolve(import.meta.dirname, '../src');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : [path.join(dir, f)]));
  const sources = walk(root).filter((f) => f.endsWith('.ts'));

  it('only config.ts reads the environment, and nothing branches on NODE_ENV except through config.isProd', () => {
    const offenders = sources.filter((f) => !f.endsWith('config.ts') && /process\.env/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
    const branches = sources.filter((f) => /config\.env\s*[!=]==?\s*'(development|test)'|NODE_ENV/.test(readFileSync(f, 'utf8')) && !f.endsWith('config.ts'));
    expect(branches.map((f) => path.relative(root, f))).toEqual([]);
  });

  const pool = createPool(TEST_DB_URL);
  afterAll(() => pool.end());
  // A valid production configuration; the pool (not the config) is what the app uses to reach the disposable test database.
  const app = createApp({ config: { ...loadConfig(prod({ LOG_LEVEL: 'silent' })), databaseUrl: TEST_DB_URL }, pool, clock: new FakeClock(T0), mailer: new DisabledMailer() });

  it.each(['/api/debug', '/api/seed', '/api/demo', '/api/admin', '/api/test', '/api/reset', '/api/dev/login', '/api/auth/dev-login', '/api/__routes', '/api/metrics', '/graphql', '/api-docs'])('%s does not exist', async (p) => {
    for (const method of ['get', 'post'] as const) {
      const res = await request(app)[method](p).set(CSRF);
      expect([401, 404], `${method} ${p}`).toContain(res.status);
      if (res.status === 401) expect(p.startsWith('/api')).toBe(true);
    }
    expect((await request(app).get(p)).status).toBe(404);
  });

  it('error responses carry the documented envelope only: no stack traces or internals', async () => {
    const res = await request(app).post('/api/auth/login').set(CSRF).set('Content-Type', 'application/json').send('{"email": ');
    expect(res.status).toBe(400);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules|at .*\(|SyntaxError/);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('production cookies, headers and CORS (built from a production configuration)', () => {
  const pool = createPool(TEST_DB_URL);
  const realConfig = { ...loadConfig(prod({ LOG_LEVEL: 'silent' })), databaseUrl: TEST_DB_URL };
  const app = createApp({ config: realConfig, pool, clock: new FakeClock(T0), mailer: new DisabledMailer() });
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  it('the session cookie is __Host- prefixed, Secure, HttpOnly, SameSite=Lax, path /, with no Domain', async () => {
    const res = await request(app).post('/api/auth/register').set(CSRF).set('Origin', 'https://app.example.com').send({ email: uniqueEmail(), password: PASSWORD, displayName: 'P' });
    expect(res.status).toBe(201);
    const header = setCookieHeader(res, '__Host-sc_sid')!;
    expect(header).toBeDefined();
    expect(header).toMatch(/;\s*Secure/i);
    expect(header).toMatch(/;\s*HttpOnly/i);
    expect(header).toMatch(/;\s*SameSite=Lax/i);
    expect(header).toMatch(/;\s*Path=\//i);
    expect(header).not.toMatch(/Domain=/i);
    expect(sessionCookie(res, 'sc_sid')).toBeUndefined();
  });

  it('only the configured https origin may use the API from a browser', async () => {
    const ok = await request(app).post('/api/auth/login').set(CSRF).set('Origin', 'https://app.example.com').send({ email: 'a@example.com', password: 'x' });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const bad = await request(app).post('/api/auth/login').set(CSRF).set('Origin', 'http://localhost:5173').send({ email: 'a@example.com', password: 'x' });
    expect(bad.status).toBe(403);
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends the hardening headers', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
  });
});

describe('health endpoints', () => {
  const pool = createPool(TEST_DB_URL);
  const config = { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_DB_URL, LOG_LEVEL: 'silent' }) };
  afterAll(() => pool.end());

  it('liveness never touches the database; readiness does, and reveals nothing when it fails', async () => {
    const ok = createApp({ config, pool, clock: new FakeClock(T0), mailer: new DisabledMailer() });
    expect((await request(ok).get('/api/health')).body).toEqual({ data: { status: 'ok' } });
    expect((await request(ok).get('/api/health/ready')).body).toEqual({ data: { status: 'ok', database: 'ok' } });

    const broken = createPool('postgres://nobody:nothing@127.0.0.1:1/none');
    const down = createApp({ config, pool: broken, clock: new FakeClock(T0), mailer: new DisabledMailer() });
    expect((await request(down).get('/api/health')).status).toBe(200);
    const res = await request(down).get('/api/health/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: 'NOT_READY', message: 'The service is not ready.' } });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONN|127\.0\.0\.1|nobody|password/);
    await broken.end().catch(() => undefined);
  });

  it('an idle-connection error on the pool is reported, not fatal', async () => {
    const errors: Error[] = [];
    const p = createPool(TEST_DB_URL, (e) => errors.push(e));
    p.emit('error', new Error('simulated idle client failure'));
    expect(errors).toHaveLength(1);
    await p.end();
  });
});

describe('SMTP transport security and readiness abuse (Stage 10)', () => {
  const smtpEnv = { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_FROM: 'SubCycle <a@example.com>' };

  it('STARTTLS is mandatory by default and cannot be disabled in production', async () => {
    const { SmtpMailer } = await import('../src/mail/mailer.js');
    const options = (c: ReturnType<typeof loadConfig>) => (new SmtpMailer(c.smtp!) as unknown as { transport: { options: Record<string, unknown> } }).transport.options;
    const starttls = loadConfig({ DATABASE_URL: TEST_DB_URL, ...smtpEnv });
    expect(starttls.smtp).toMatchObject({ secure: false, requireTls: true });
    expect(options(starttls)).toMatchObject({ secure: false, requireTLS: true });
    expect(options(loadConfig({ DATABASE_URL: TEST_DB_URL, ...smtpEnv, SMTP_PORT: '465', SMTP_SECURE: 'true' }))).toMatchObject({ secure: true, requireTLS: false }); // implicit TLS already
    expect(options(loadConfig({ DATABASE_URL: TEST_DB_URL, ...smtpEnv, SMTP_REQUIRE_TLS: 'false' }))).toMatchObject({ requireTLS: false }); // development / local test servers only
    expect(() => loadConfig(prod({ ...smtpEnv, SMTP_REQUIRE_TLS: 'false' }))).toThrow(/SMTP_REQUIRE_TLS=false is not allowed in production/);
    expect(loadConfig(prod(smtpEnv)).smtp).toMatchObject({ requireTls: true });
  });

  it('the readiness route is rate limited on its own, so it cannot be used to exhaust the pool', async () => {
    const pool = createPool(TEST_DB_URL);
    try {
      const config = { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_DB_URL, LOG_LEVEL: 'silent' }) };
      config.rateLimit = { ...config.rateLimit, apiMax: 3 };
      const app = createApp({ config, pool, clock: new FakeClock(T0), mailer: new DisabledMailer() });
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await request(app).get('/api/health/ready')).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
      expect((await request(app).get('/api/health')).status).toBe(200); // liveness is never throttled
    } finally {
      await pool.end();
    }
  });
});
