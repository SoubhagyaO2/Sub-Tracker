import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';

export const defaultMigrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

// Arbitrary constant: serializes concurrent migrators (e.g. two app instances starting).
const MIGRATION_LOCK_KEY = 727_001;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const toLf = (text: string): string => text.replace(/\r\n/g, '\n');

/** SHA-256 of the file with Unix line endings, so the same migration hashes the same on Windows (CRLF checkouts) and Linux. */
const checksumOf = (sql: string): string => sha256(toLf(sql));

/** Databases migrated before line endings were normalised stored the hash of the raw file, which may have been CRLF; both forms stay valid. */
const acceptedChecksums = (sql: string): string[] => [checksumOf(sql), sha256(toLf(sql).replace(/\n/g, '\r\n'))];

/**
 * Applies forward-only numbered .sql files, one transaction per file.
 * Applied files are checksummed; editing an applied migration is an error.
 * Returns the names applied by this call.
 */
export async function migrate(pool: Pool, dir: string = defaultMigrationsDir): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = checksumOf(sql);
      const existing = done.get(file);
      if (existing !== undefined) {
        if (!acceptedChecksums(sql).includes(existing)) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch)`);
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
