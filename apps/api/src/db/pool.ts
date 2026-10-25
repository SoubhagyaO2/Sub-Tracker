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

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString, max: 10 });
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
