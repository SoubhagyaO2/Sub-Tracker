import type { SubscriptionDto } from '@subcycle/shared';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { FakeClock } from '../src/clock.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Pool } from '../src/db/pool.js';
import { DisabledMailer, type Mailer, type MailMessage } from '../src/mail/mailer.js';
import { TEST_DB_URL } from './dbUrl.js';

export const ORIGIN = 'http://localhost:5173';
export const CSRF = { 'X-SubCycle-Client': 'web' } as const;
export const PASSWORD = 'Tr0ub4dor&3-horse';
export const T0 = '2030-01-15T10:00:00.000Z';
export const DAY = 24 * 60 * 60 * 1000;

export class FakeMailer implements Mailer {
  readonly configured = true;
  sent: MailMessage[] = [];
  failNext = false;
  async send(message: MailMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('SMTP connection refused (simulated)');
    }
    this.sent.push(message);
  }
}

export interface Overrides {
  rateLimit?: Partial<Config['rateLimit']>;
  mailer?: Mailer;
  env?: NodeJS.ProcessEnv;
}

export function testConfig(o: Overrides = {}): Config {
  const base = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    CORS_ORIGINS: ORIGIN,
    LOG_LEVEL: 'silent',
    ...o.env,
  });
  return {
    ...base,
    // Generous by default so unrelated tests never trip limits; limit tests override explicitly.
    rateLimit: { ...base.rateLimit, authMax: 1000, loginPerEmailMax: 1000, apiMax: 100_000, ...o.rateLimit },
  };
}

export interface TestCtx {
  app: Express;
  pool: Pool;
  clock: FakeClock;
  mailer: Mailer;
  config: Config;
}

export function createCtx(o: Overrides = {}): TestCtx {
  const config = testConfig(o);
  const pool = createPool(TEST_DB_URL);
  const clock = new FakeClock(T0);
  const mailer = o.mailer ?? new DisabledMailer();
  return { app: createApp({ config, pool, clock, mailer }), pool, clock, mailer, config };
}

export async function resetDb(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE users CASCADE');
}

/** Extracts "name=value" for the session cookie from a response, or undefined if none was set. */
export function sessionCookie(res: request.Response, name = 'sc_sid'): string | undefined {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const match = list.find((c) => c.startsWith(`${name}=`));
  return match?.split(';')[0];
}

export function setCookieHeader(res: request.Response, name = 'sc_sid'): string | undefined {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.find((c) => c.startsWith(`${name}=`));
}

let counter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}${++counter}@example.com`;

export async function registerUser(
  app: Express,
  overrides: Record<string, unknown> = {},
): Promise<{ res: request.Response; cookie: string; email: string }> {
  const email = (overrides.email as string | undefined) ?? uniqueEmail();
  const res = await request(app)
    .post('/api/auth/register')
    .set(CSRF)
    .send({ email, password: PASSWORD, displayName: 'Test User', ...overrides });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { res, cookie: sessionCookie(res)!, email };
}

export const me = (app: Express, cookie?: string) => {
  const r = request(app).get('/api/auth/me');
  return cookie ? r.set('Cookie', cookie) : r;
};

// ───────────── subscription helpers ─────────────

type Verb = 'get' | 'post' | 'patch' | 'delete';

/** Thin authenticated client: attaches the session cookie and the CSRF header on every call. */
export function client(app: Express, cookie?: string) {
  const call = (verb: Verb, url: string, body?: unknown) => {
    let r = request(app)[verb](url);
    if (verb !== 'get') r = r.set(CSRF);
    if (cookie) r = r.set('Cookie', cookie);
    return body === undefined ? r : r.send(body as object);
  };
  return {
    get: (url: string) => call('get', url),
    post: (url: string, body?: unknown) => call('post', url, body),
    patch: (url: string, body?: unknown) => call('patch', url, body),
    del: (url: string) => call('delete', url),
  };
}

export const SUB = { name: 'Netflix', amountMinor: 64900, billingFrequency: 'monthly', nextBillingDate: '2030-02-01' } as const;

export async function createSub(app: Express, cookie: string, overrides: Record<string, unknown> = {}) {
  const res = await client(app, cookie).post('/api/subscriptions', { ...SUB, ...overrides });
  if (res.status !== 201) throw new Error(`createSub failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as SubscriptionDto;
}

export interface SubRowOverrides {
  name?: string;
  category?: string;
  amount_minor?: number;
  currency?: string;
  billing_frequency?: string;
  anchor_date?: string;
  next_billing_date?: string;
  start_date?: string;
  trial_end_date?: string | null;
  status?: string;
  status_before_archive?: string | null;
  cancelled_on?: string | null;
  created_at?: string;
}

/** Inserts a subscription directly (bypassing the API) so tests can set up any status/date combination. */
export async function insertSub(pool: Pool, userId: string, o: SubRowOverrides = {}): Promise<string> {
  const next = o.next_billing_date ?? '2030-02-01';
  const v = {
    name: 'Seed', category: 'other', amount_minor: 10000, currency: 'INR', billing_frequency: 'monthly',
    anchor_date: next, next_billing_date: next, start_date: '2030-01-01', trial_end_date: null,
    status: 'active', status_before_archive: null, cancelled_on: null, created_at: '2030-01-01T00:00:00Z',
    ...o,
  };
  const { rows } = await pool.query(
    `INSERT INTO subscriptions (user_id, name, category, amount_minor, currency, billing_frequency, anchor_date,
       next_billing_date, start_date, trial_end_date, status, status_before_archive, cancelled_on, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [userId, v.name, v.category, v.amount_minor, v.currency, v.billing_frequency, v.anchor_date, v.next_billing_date,
     v.start_date, v.trial_end_date, v.status, v.status_before_archive, v.cancelled_on, v.created_at],
  );
  return rows[0].id as string;
}

export const userIdOf = (res: request.Response): string => res.body.data.user.id as string;

// ───────────── failure injection ─────────────

/**
 * Temporarily makes every INSERT/UPDATE/DELETE on `table` fail inside PostgreSQL, to prove that multi-statement
 * operations roll back completely. Always removed afterwards. Safe because test files run serially.
 */
export async function withFailingTrigger<T>(
  pool: Pool,
  table: 'subscriptions' | 'payments' | 'subscription_price_history',
  event: 'INSERT' | 'UPDATE' | 'DELETE',
  fn: () => Promise<T>,
): Promise<T> {
  const trigger = `test_fail_${table}_${event.toLowerCase()}`;
  await pool.query(
    `CREATE OR REPLACE FUNCTION test_always_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated failure'; END $$`,
  );
  await pool.query(`CREATE TRIGGER ${trigger} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION test_always_fail()`);
  try {
    return await fn();
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
    await pool.query('DROP FUNCTION IF EXISTS test_always_fail()');
  }
}
