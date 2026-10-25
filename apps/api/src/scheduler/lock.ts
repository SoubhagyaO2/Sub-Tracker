import type { Pool } from '../db/pool.js';

/** Arbitrary constant naming the scheduler's cross-process lock (see migrate.ts for the migration lock). */
export const SCHEDULER_LOCK_KEY = 727_002;

/**
 * Runs `fn` only if no other session holds the advisory lock, WITHOUT waiting.
 * The lock is held on one dedicated connection and is released when `fn` ends. If this process dies, PostgreSQL
 * releases the lock when the connection closes, so a crash can never wedge the scheduler.
 *
 * Caveat (documented): session-level advisory locks do not survive transaction-pooling proxies such as pgbouncer in
 * "transaction" mode. Use a direct connection or session pooling for the API.
 */
export async function withAdvisoryLock<T>(pool: Pool, key: number, fn: () => Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const client = await pool.connect();
  let unlocked = false;
  try {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (!rows[0]!.ok) {
      unlocked = true; // we never held it
      return { acquired: false };
    }
    try {
      return { acquired: true, value: await fn() };
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [key]);
        unlocked = true;
      } catch {
        /* the connection is destroyed below, which releases the lock */
      }
    }
  } finally {
    client.release(!unlocked); // a connection that may still hold the lock is closed, not returned to the pool
  }
}
