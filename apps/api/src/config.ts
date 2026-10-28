import { MAX_REMINDER_ATTEMPTS, RETRY_BACKOFF_MINUTES } from '@subcycle/shared';
import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  /** With `secure` false (STARTTLS ports), refuse to continue unless the connection upgrades to TLS: no cleartext credentials or mail. */
  requireTls: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface Config {
  env: 'development' | 'test' | 'production';
  isProd: boolean;
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  appUrl: string;
  trustProxy: boolean | number;
  logLevel: string;
  /** null => email is disabled; features depending on it report "unavailable". */
  smtp: SmtpConfig | null;
  /** Production settings that are allowed but probably not what the operator wants; logged once at start-up. */
  warnings: string[];
  session: {
    cookieName: string;
    idleMs: number;
    absoluteMs: number;
    /** last_seen is refreshed at most this often, to limit writes. */
    touchIntervalMs: number;
  };
  emailVerification: { tokenTtlMs: number; resendCooldownMs: number };
  scheduler: {
    /** Run the background scheduler inside this API process. Set false to run the API without it (e.g. a dedicated worker elsewhere). */
    enabled: boolean;
    intervalMs: number;
    /** A claimed reminder is invisible to other workers for this long; if the claimer dies it becomes due again afterwards. */
    leaseMs: number;
    claimBatch: number;
    maxAttempts: number;
    /** Minutes to wait after the Nth failed attempt (index N-1). */
    backoffMinutes: readonly number[];
  };
  rateLimit: {
    authWindowMs: number;
    authMax: number;
    loginPerEmailMax: number;
    apiWindowMs: number;
    apiMax: number;
  };
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGINS: z.string().default(''),
  APP_URL: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.string().default('false'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_REQUIRE_TLS: z.enum(['true', 'false']).default('true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SCHEDULER_ENABLED: z.enum(['true', 'false']).default('true'),
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
});

function dropEmpty(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(dropEmpty(rawEnv));
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';

  const corsOrigins = e.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const o of corsOrigins) {
    if (o === '*' || !/^https?:\/\/[^/]+$/.test(o)) {
      throw new Error(`Invalid CORS origin "${o}": use explicit origins like https://app.example.com`);
    }
  }
  if (isProd && corsOrigins.length === 0) {
    throw new Error('CORS_ORIGINS must be set in production');
  }
  if (isProd && !e.APP_URL.startsWith('https://')) {
    throw new Error('APP_URL must be https in production');
  }
  const warnings: string[] = [];
  if (isProd && e.SMTP_REQUIRE_TLS === 'false') throw new Error('SMTP_REQUIRE_TLS=false is not allowed in production: mail and credentials must not travel in cleartext');
  if (isProd) {
    // Unsafe defaults that must never reach production.
    for (const o of corsOrigins) {
      if (!o.startsWith('https://')) throw new Error(`CORS origin "${o}" must be https in production`);
    }
    for (const u of [e.APP_URL, ...corsOrigins]) {
      if (/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(u)) throw new Error(`"${u}" points at this machine: set the real public URL in production`);
    }
    let db: URL;
    try {
      db = new URL(e.DATABASE_URL);
    } catch {
      throw new Error('DATABASE_URL is not a valid URL');
    }
    if (decodeURIComponent(db.username) === 'subcycle' && decodeURIComponent(db.password) === 'subcycle') {
      throw new Error('DATABASE_URL uses the documented development credentials (subcycle/subcycle): create a dedicated database user with a generated password');
    }
    if (!db.password) throw new Error('DATABASE_URL must include a password in production');
    const ssl = db.searchParams.get('sslmode');
    if (ssl === null || ssl === 'disable' || ssl === 'allow' || ssl === 'prefer') {
      warnings.push('DATABASE_URL does not require TLS (set sslmode=require or verify-full) unless the database is reachable only over a private network');
    }
    if (e.TRUST_PROXY === 'false') warnings.push('TRUST_PROXY is false: behind a reverse proxy every client shares one IP, so rate limits apply to all users together');
    if (e.LOG_LEVEL === 'debug' || e.LOG_LEVEL === 'trace') warnings.push(`LOG_LEVEL=${e.LOG_LEVEL} is noisy in production`);
  }

  const smtpSet = [e.SMTP_HOST, e.SMTP_PORT, e.SMTP_FROM].filter((v) => v !== undefined).length;
  if (smtpSet !== 0 && smtpSet !== 3) {
    throw new Error('SMTP is partially configured: SMTP_HOST, SMTP_PORT and SMTP_FROM must all be set (or none)');
  }
  const smtp: SmtpConfig | null =
    smtpSet === 3
      ? {
          host: e.SMTP_HOST!,
          port: e.SMTP_PORT!,
          secure: e.SMTP_SECURE === 'true',
          requireTls: e.SMTP_REQUIRE_TLS === 'true',
          user: e.SMTP_USER,
          pass: e.SMTP_PASS,
          from: e.SMTP_FROM!,
        }
      : null;

  const trustProxy =
    e.TRUST_PROXY === 'true' ? true : e.TRUST_PROXY === 'false' ? false : Number(e.TRUST_PROXY);
  if (typeof trustProxy === 'number' && (!Number.isInteger(trustProxy) || trustProxy < 0)) {
    throw new Error('TRUST_PROXY must be "true", "false" or a non-negative integer');
  }

  return {
    env: e.NODE_ENV,
    isProd,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    corsOrigins,
    appUrl: e.APP_URL.replace(/\/$/, ''),
    trustProxy,
    logLevel: e.LOG_LEVEL,
    smtp,
    warnings,
    session: {
      // The __Host- prefix requires Secure + Path=/ + no Domain, so it is only used in production (https).
      cookieName: isProd ? '__Host-sc_sid' : 'sc_sid',
      idleMs: 14 * DAY_MS,
      absoluteMs: 30 * DAY_MS,
      touchIntervalMs: 5 * 60 * 1000,
    },
    emailVerification: { tokenTtlMs: DAY_MS, resendCooldownMs: 60 * 1000 },
    scheduler: {
      enabled: e.SCHEDULER_ENABLED === 'true',
      intervalMs: e.SCHEDULER_INTERVAL_SECONDS * 1000,
      leaseMs: 10 * 60 * 1000,
      claimBatch: 50,
      maxAttempts: MAX_REMINDER_ATTEMPTS,
      backoffMinutes: RETRY_BACKOFF_MINUTES,
    },
    rateLimit: {
      authWindowMs: 15 * 60 * 1000,
      authMax: 10,
      loginPerEmailMax: 10,
      apiWindowMs: 60 * 1000,
      apiMax: 300,
    },
  };
}
