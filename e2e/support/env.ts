import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * The browser suite creates and deletes users, so it only ever talks to a database whose name ends in "_e2e".
 * Everything that touches the database goes through this module, which checks the name first.
 */
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgres://subcycle:subcycle@localhost:5434/subcycle_e2e';
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3101);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4273);
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;

export function databaseName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('E2E_DATABASE_URL is not a valid URL.');
  }
}

export function assertE2eDatabase(url = E2E_DATABASE_URL): string {
  const name = databaseName(url);
  if (!/^[a-z0-9_]+_e2e$/.test(name)) {
    throw new Error(`Refusing to touch database "${name}": the browser suite only runs against a database whose name ends with "_e2e" (set E2E_DATABASE_URL).`);
  }
  return name;
}

/**
 * Every run has its own namespace (set once by playwright.config.ts and inherited by the workers). Test users are
 * `e2e-<run id>-<random>@example.com` (reserved domain, never deliverable) and a run only ever deletes ITS OWN users, so
 * two runs against the same database cannot delete each other's data. Users left behind by a crashed run are removed
 * only once they are more than an hour old (`deleteStaleTestUsers`).
 */
// The first process to load this module (the Playwright runner, via playwright.config.ts) creates the id; workers inherit it.
process.env.E2E_RUN_ID ??= randomBytes(4).toString('hex');
export const RUN_ID = process.env.E2E_RUN_ID;
if (!/^[0-9a-f]{8}$/.test(RUN_ID)) throw new Error('E2E_RUN_ID must be 8 hex characters');
export const EMAIL_PREFIX = `e2e-${RUN_ID}-`;
export const EMAIL_DOMAIN = '@example.com';

let pool: pg.Pool | undefined;
export function db(): pg.Pool {
  assertE2eDatabase();
  pool ??= new pg.Pool({ connectionString: E2E_DATABASE_URL, max: 3 });
  return pool;
}
export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** Deletes this run's users: the given ones, or all of them. Never matches another run's or a real address. */
export async function deleteTestUsers(emails?: string[]): Promise<number> {
  const pattern = `${EMAIL_PREFIX}%${EMAIL_DOMAIN}`;
  const res = emails
    ? await db().query('DELETE FROM users WHERE email = ANY($1::text[]) AND email LIKE $2', [emails, pattern])
    : await db().query('DELETE FROM users WHERE email LIKE $1', [pattern]);
  return res.rowCount ?? 0;
}

/** Removes test users from crashed runs: only `e2e-` users on the reserved domain that are over an hour old. */
export async function deleteStaleTestUsers(): Promise<number> {
  const res = await db().query("DELETE FROM users WHERE email LIKE 'e2e-%@example.com' AND created_at < now() - interval '1 hour'");
  return res.rowCount ?? 0;
}
