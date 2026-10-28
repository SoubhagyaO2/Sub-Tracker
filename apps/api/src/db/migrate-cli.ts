import { loadConfig } from '../config.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

const config = loadConfig();
// A schema change on a large table can legitimately run for minutes: the 30 s request timeout does not apply to migrations.
const pool = createPool(config.databaseUrl, undefined, { statementTimeoutMs: 0 });
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
