import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF, ORIGIN, PASSWORD, createCtx, me, registerUser, resetDb, setCookieHeader, uniqueEmail } from './helpers.js';

describe('CSRF, CORS and headers', () => {
  const ctx = createCtx();
  const { app, pool } = ctx;
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  const body = () => ({ email: uniqueEmail(), password: PASSWORD, displayName: 'A' });

  it('rejects state-changing requests without the custom header', async () => {
    const res = await request(app).post('/api/auth/register').send(body());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
    expect((await pool.query('SELECT count(*)::int n FROM users')).rows[0].n).toBe(0);
  });

  it('rejects a disallowed Origin even when the header is present', async () => {
    const res = await request(app).post('/api/auth/register').set(CSRF).set('Origin', 'https://evil.example').send(body());
    expect(res.status).toBe(403);
  });

  it('accepts the allowlisted Origin and echoes it with credentials for CORS', async () => {
    const res = await request(app).post('/api/auth/register').set(CSRF).set('Origin', ORIGIN).send(body());
    expect(res.status).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not emit CORS headers for other origins (no wildcard)', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await request(app)
      .options('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('GET requests do not require the header', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
  });

  it('sets security headers, hides the framework, and tags requests', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ignores a client-supplied request id', async () => {
    const res = await request(app).get('/api/health').set('X-Request-Id', 'attacker-chosen-id');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the standard 404 envelope for unknown routes', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });
});

describe('production cookie settings', () => {
  const ctx = createCtx({
    env: { NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com', APP_URL: 'https://app.example.com' },
  });
  beforeEach(() => resetDb(ctx.pool));
  afterAll(() => ctx.pool.end());

  it('uses the __Host- prefix with Secure, HttpOnly, SameSite=Lax and Path=/ (and no Domain)', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/register')
      .set(CSRF)
      .set('Origin', 'https://app.example.com')
      .send({ email: uniqueEmail(), password: PASSWORD, displayName: 'A' });
    expect(res.status).toBe(201);
    const header = setCookieHeader(res, '__Host-sc_sid')!;
    expect(header).toBeDefined();
    expect(header).toMatch(/; Secure/);
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; SameSite=Lax/);
    expect(header).toMatch(/; Path=\//);
    expect(header).not.toMatch(/Domain=/i);
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('rejects the dev origin in production', async () => {
    const res = await request(ctx.app).post('/api/auth/login').set(CSRF).set('Origin', ORIGIN).send({ email: 'a@example.com', password: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('user isolation of identity', () => {
  const ctx = createCtx();
  const { app, pool } = ctx;
  beforeEach(() => resetDb(pool));
  afterAll(() => pool.end());

  it('each session resolves only to its own user, and ending one user’s session never affects another', async () => {
    const a = await registerUser(app, { displayName: 'Alice' });
    const b = await registerUser(app, { displayName: 'Bob' });
    expect((await me(app, a.cookie)).body.data.user.displayName).toBe('Alice');
    expect((await me(app, b.cookie)).body.data.user.displayName).toBe('Bob');

    await request(app).post('/api/auth/logout').set(CSRF).set('Cookie', a.cookie).expect(204);
    expect((await me(app, a.cookie)).status).toBe(401);
    expect((await me(app, b.cookie)).status).toBe(200);
  });

  it('a user’s preferences and data are separate rows keyed by their own id', async () => {
    const a = await registerUser(app, { timezone: 'Europe/London' });
    const b = await registerUser(app, { timezone: 'Asia/Tokyo' });
    expect((await me(app, a.cookie)).body.data.preferences.timezone).toBe('Europe/London');
    expect((await me(app, b.cookie)).body.data.preferences.timezone).toBe('Asia/Tokyo');
  });

  it('a session token for one user cannot be used by presenting another user’s email', async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    // A tampered cookie that swaps in a different value than issued is simply unknown.
    const forged = a.cookie.slice(0, -3) + 'AAA';
    expect((await me(app, forged)).status).toBe(401);
    expect((await me(app, b.cookie)).body.data.user.email).toBe(b.email);
  });
});

describe('SQL safety guard', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
    });
  }

  /**
   * The ONLY expressions allowed inside a query() template literal, per file. Each is built from constants
   * or numbered placeholders ($1, $2, ...), never from request data (see services/subscriptions.ts):
   *   whereSql     - AND-joined fragments from literals; values are bound parameters
   *   SORT_SQL[..] - ORDER BY text chosen from a fixed allowlist keyed by a validated enum
   *   dir          - the literal 'ASC' or 'DESC'
   *   limit/offset - placeholder strings like "$7", produced by bind()
   */
  const ALLOWED_INTERPOLATIONS: Record<string, string[]> = {
    'services/subscriptions.ts': ['whereSql', 'SORT_SQL[sort]', 'dir', 'limit', 'offset'],
    // SELECT is a fixed constant statement prefix; whereSql is AND-joined literals with bound values; limit/offset are $n placeholders.
    'services/reminders.ts': ['SELECT', 'whereSql', 'limit', 'offset'],
  };

  const srcDir = path.resolve(import.meta.dirname, '../src');
  const queryTemplate = /\.query(?:<[^>]*>)?\(\s*`([^`]*)`/g;
  const stringConcat = /\.query(?:<[^>]*>)?\(\s*['"][^'"]*['"]\s*\+/;

  it('no query() call interpolates anything outside the per-file allowlist, or concatenates strings', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const rel = path.relative(srcDir, file).split(path.sep).join('/');
      const text = readFileSync(file, 'utf8');
      if (stringConcat.test(text)) offenders.push(`${rel}: string concatenation`);
      for (const m of text.matchAll(queryTemplate)) {
        for (const expr of m[1]!.matchAll(/\$\{([^}]*)\}/g)) {
          if (!(ALLOWED_INTERPOLATIONS[rel] ?? []).includes(expr[1]!.trim())) offenders.push(`${rel}: \${${expr[1]}}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guard itself works: it would flag an unlisted interpolation', () => {
    const sample = 'db.query(`SELECT * FROM t WHERE id = ${userInput}`)';
    const hits = [...sample.matchAll(queryTemplate)].flatMap((m) => [...m[1]!.matchAll(/\$\{([^}]*)\}/g)].map((e) => e[1]));
    expect(hits).toEqual(['userInput']);
    expect(ALLOWED_INTERPOLATIONS['services/subscriptions.ts']).not.toContain('userInput');
  });
});
