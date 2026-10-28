import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { TEST_DB_URL, assertDisposableDatabase } from './dbUrl.js';

/** Rebuilds the test database schema from the real migration files before the suite runs. */
export default async function setup(): Promise<void> {
  assertDisposableDatabase(TEST_DB_URL); // before anything is dropped
  const pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 2 });
  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool);
  } catch (err) {
    throw new Error(
      `Could not prepare the test database at ${TEST_DB_URL.replace(/:[^:@/]*@/, ':***@')}. ` +
        `Is it running? Try "npm run db:up". Cause: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    await pool.end();
  }
}
