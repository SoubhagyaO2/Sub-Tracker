import type { SubscriptionDto } from '@subcycle/shared';
import type { Express } from 'express';
import { Writable } from 'node:stream';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { FakeClock } from '../src/clock.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool, type Pool } from '../src/db/pool.js';
import { createLogger, type Logger } from '../src/logger.js';
import type { ReminderEnv } from '../src/services/reminders.js';
import { DisabledMailer, type Mailer, type MailMessage } from '../src/mail/mailer.js';
import { TEST_DB_URL } from './dbUrl.js';

export const ORIGIN = 'http://localhost:5173';
export const CSRF = { 'X-SubCycle-Client': 'web' } as const;
export const PASSWORD = 'Tr0ub4dor&3-horse';
export const T0 = '2030-01-15T10:00:00.000Z';
export const DAY = 24 * 60 * 60 * 1000;

/** A provider error shaped like nodemailer's: `responseCode` for SMTP replies, `code` for network-level failures. */
export const smtpError = (responseCode: number) => Object.assign(new Error(`${responseCode} simulated SMTP reply (secret-provider-text user@example.com)`), { responseCode });
export const networkError = (code = 'ETIMEDOUT') => Object.assign(new Error(`${code} simulated`), { code });

export class FakeMailer implements Mailer {
  configured = true;
  sent: MailMessage[] = [];
  failNext = false;
  /** Errors thrown by the next sends, in order (consumed one per send). */
  errors: unknown[] = [];
  /** Runs before each send resolves: lets tests hold a send open to exercise concurrency. */
  onSend?: (m: MailMessage) => Promise<void>;
  attempts = 0;
  async send(message: MailMessage): Promise<void> {
    this.attempts++;
    await this.onSend?.(message);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('SMTP connection refused (simulated)');
    }
    if (this.errors.length) throw this.errors.shift();
    this.sent.push(message);
  }
}

export interface Overrides {
  rateLimit?: Partial<Config['rateLimit']>;
  scheduler?: Partial<Config['scheduler']>;
  logger?: Logger;
  mailer?: Mailer;
  env?: NodeJS.ProcessEnv;
}

export function testConfig(o: Overrides = {}): Config {
  // Production configuration rejects the development database credentials, so a production-flavoured test config is validated
  // against a placeholder URL; the tests reach the real (disposable) database through the pool they create, not through this field.
  const production = o.env?.NODE_ENV === 'production';
  const base = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: production ? 'postgres://app_user:placeholder-pw@db.invalid:5432/subcycle?sslmode=require' : TEST_DB_URL,
    CORS_ORIGINS: ORIGIN,
    LOG_LEVEL: 'silent',
    ...o.env,
  });
  return {
    ...base,
    databaseUrl: TEST_DB_URL,
    // Generous by default so unrelated tests never trip limits; limit tests override explicitly.
    rateLimit: { ...base.rateLimit, authMax: 1000, loginPerEmailMax: 1000, apiMax: 100_000, ...o.rateLimit },
    scheduler: { ...base.scheduler, ...o.scheduler },
  };
}

export interface TestCtx {
  app: Express;
  pool: Pool;
  clock: FakeClock;
  mailer: Mailer;
  config: Config;
  logger: Logger;
  /** Everything the scheduler and reminder services need. */
  env: ReminderEnv;
}

export function createCtx(o: Overrides = {}): TestCtx {
  const config = testConfig(o);
  const pool = createPool(TEST_DB_URL);
  const clock = new FakeClock(T0);
  const mailer = o.mailer ?? new DisabledMailer();
  const logger = o.logger ?? createLogger({ logLevel: 'silent' });
  return { app: createApp({ config, pool, clock, mailer, logger }), pool, clock, mailer, config, logger, env: { pool, clock, mailer, config, logger } };
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
  origin?: string,
): Promise<{ res: request.Response; cookie: string; email: string }> {
  const email = (overrides.email as string | undefined) ?? uniqueEmail();
  let req = request(app).post('/api/auth/register').set(CSRF);
  if (origin) req = req.set('Origin', origin);
  const res = await req.send({ email, password: PASSWORD, displayName: 'Test User', ...overrides });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { res, cookie: (sessionCookie(res) ?? sessionCookie(res, '__Host-sc_sid'))!, email };
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
    del: (url: string, body?: unknown) => call('delete', url, body),
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

// ───────────── log capture ─────────────

/** A real pino logger writing into memory, so tests can assert on exactly what would be logged. */
export function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(...chunk.toString().split(String.fromCharCode(10)).filter(Boolean));
      cb();
    },
  });
  const logger = createLogger({ logLevel: 'debug' }, stream);
  return { logger, lines, events: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>), text: () => lines.join(String.fromCharCode(10)) };
}

/** Registers a user and sets their preferences directly (bypassing the API) for scheduler-level tests. */
export async function setPrefs(pool: Pool, userId: string, p: Partial<{ timezone: string; reminder_lead_days: number; reminder_hour: number; in_app_reminders: boolean; email_reminders_enabled: boolean; trial_reminders_enabled: boolean }>) {
  const entries = Object.entries(p);
  if (!entries.length) return;
  await pool.query(`UPDATE user_preferences SET ${entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE user_id = $1`, [userId, ...entries.map(([, v]) => v)]);
}

export const verifyEmail = (pool: Pool, userId: string) => pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]);

export async function remindersOf(pool: Pool, userId: string) {
  const { rows } = await pool.query(
    `SELECT id, subscription_id, kind, channel, target_date::text AS target_date, lead_days, remind_at, status, skip_reason, attempts, next_attempt_at, last_error, sent_at, read_at
       FROM reminders WHERE user_id = $1 ORDER BY target_date, channel, id`,
    [userId],
  );
  return rows as {
    id: string; subscription_id: string; kind: string; channel: string; target_date: string; lead_days: number; remind_at: Date; status: string;
    skip_reason: string | null; attempts: number; next_attempt_at: Date | null; last_error: string | null; sent_at: Date | null; read_at: Date | null;
  }[];
}

/** Signs in again (for tests that move the clock past the 14/30-day session limits) and returns the cookie. */
export async function loginCookie(app: Express, email: string, password = PASSWORD): Promise<string> {
  const res = await request(app).post('/api/auth/login').set(CSRF).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return sessionCookie(res)!;
}
