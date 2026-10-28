import pg from 'pg';

// pg's defaults would corrupt two things this app depends on:
//  - DATE (1082) is parsed into a local-midnight JS Date, which shifts billing dates across time zones.
//    Keep date-only values as 'YYYY-MM-DD' strings end to end.
//  - BIGINT (20) arrives as a string. Money is bigint minor units capped at 10^12 by a CHECK constraint,
//    so it is always a safe integer; refuse anything that is not rather than silently losing precision.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError('bigint value exceeds the safe integer range');
  return n;
});

export type Pool = pg.Pool;
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string, onError?: (err: Error) => void, opts: { statementTimeoutMs?: number } = {}): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 10_000, // fail a request instead of queueing forever when the database is unreachable
    idleTimeoutMillis: 30_000,
    statement_timeout: opts.statementTimeoutMs ?? 30_000, // no single statement may hold a connection (and its locks) for more than 30 s (0 = none; used only by the migration runner)
    application_name: 'subcycle-api',
  });
  // An idle client that loses its connection emits 'error' on the pool; without a listener Node would crash the process.
  pool.on('error', (err) => onError?.(err));
  return pool;
}

/** Runs fn inside a transaction; commits on success, rolls back on any error. */
export async function withTransaction<T>(pool: Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
