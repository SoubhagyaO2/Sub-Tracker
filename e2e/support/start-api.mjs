// Starts the real, built API against the e2e database: creates the database if needed, applies the real migrations,
// then hands over to the production entry point. Refuses to run against any database not named *_e2e.
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must be set');
const target = new URL(url);
const name = decodeURIComponent(target.pathname.replace(/^\//, ''));
if (!/^[a-z0-9_]+_e2e$/.test(name)) throw new Error(`Refusing to start: database "${name}" does not end with "_e2e".`);

const admin = new URL(url);
admin.pathname = '/postgres';
const adminPool = new pg.Pool({ connectionString: admin.href, max: 1 });
try {
  const exists = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (exists.rowCount === 0) await adminPool.query(`CREATE DATABASE "${name}"`); // name validated above
} finally {
  await adminPool.end();
}

const root = path.resolve(import.meta.dirname, '../../apps/api/dist');
const { migrate } = await import(pathToFileURL(path.join(root, 'db/migrate.js')).href);
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await pool.query("DELETE FROM users WHERE email LIKE 'e2e-%@example.com' AND created_at < now() - interval '1 hour'"); // crashed runs only
} catch {
  /* first run: the schema does not exist yet */
}
try {
  await migrate(pool);
} finally {
  await pool.end();
}
await import(pathToFileURL(path.join(root, 'server.js')).href);
