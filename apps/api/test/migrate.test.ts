import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir, migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { TEST_DB_URL } from './dbUrl.js';

const pool = createPool(TEST_DB_URL);
afterAll(() => pool.end());

describe('schema produced by the real migrations', () => {
  it('contains every documented table', async () => {
    const { rows } = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    const names = rows.map((r) => r.table_name);
    for (const t of [
      'users', 'user_preferences', 'sessions', 'email_verification_tokens', 'subscriptions',
      'payments', 'subscription_price_history', 'reminders', 'schema_migrations',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('is idempotent: re-running applies nothing', async () => {
    expect(await migrate(pool)).toEqual([]);
    const { rows } = await pool.query('SELECT name FROM schema_migrations');
    expect(rows).toEqual([{ name: '0001_init.sql' }, { name: '0002_reminder_skip_reasons.sql' }, { name: '0003_subscription_icon_images.sql' }]);
  });

  it('0002 widens the reminder skip reasons without removing the old ones', async () => {
    await pool.query('TRUNCATE users CASCADE');
    const u = (await pool.query("INSERT INTO users (email, password_hash, display_name) VALUES ('r@example.com','h','R') RETURNING id")).rows[0].id as string;
    await pool.query(
      `INSERT INTO subscriptions (id, user_id, name, amount_minor, billing_frequency, anchor_date, next_billing_date, start_date)
       VALUES ('30000000-0000-0000-0000-000000000001', $1, 'S', 100, 'monthly', '2030-01-01', '2030-01-01', '2030-01-01')`,
      [u],
    );
    let day = 0;
    for (const reason of ['smtp_not_configured', 'email_not_verified', 'email_disabled', 'subscription_inactive', 'delivery_window_missed', 'invalid_time_zone']) {
      await pool.query(
        `INSERT INTO reminders (user_id, subscription_id, kind, channel, target_date, lead_days, remind_at, status, skip_reason)
         VALUES ($1, '30000000-0000-0000-0000-000000000001', 'renewal', 'email', DATE '2030-02-01' + $2::int, 3, now(), 'skipped', $3)`,
        [u, day++, reason],
      );
    }
    await expect(
      pool.query(`INSERT INTO reminders (user_id, subscription_id, kind, channel, target_date, lead_days, remind_at, status, skip_reason)
                  VALUES ($1, '30000000-0000-0000-0000-000000000001', 'renewal', 'email', DATE '2031-01-01', 3, now(), 'skipped', 'made_up')`, [u]),
    ).rejects.toThrow(/reminders_skip_reason_check/);
    await pool.query('TRUNCATE users CASCADE');
  });

  it('has updated_at triggers on the five documented tables', async () => {
    const { rows } = await pool.query(
      "SELECT c.relname AS tbl FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND t.tgname LIKE '%_set_updated_at' ORDER BY 1",
    );
    expect(rows.map((r) => r.tbl)).toEqual(['payments', 'reminders', 'subscriptions', 'user_preferences', 'users']);
  });

  it('actually bumps updated_at on UPDATE (users, user_preferences, subscriptions)', async () => {
    await pool.query('TRUNCATE users CASCADE');
    const u = await pool.query(
      "INSERT INTO users (email, password_hash, display_name, created_at, updated_at) VALUES ('t@example.com','h','T','2000-01-01','2000-01-01') RETURNING id",
    );
    const id = u.rows[0].id;
    await pool.query("INSERT INTO user_preferences (user_id, updated_at) VALUES ($1,'2000-01-01')", [id]);
    await pool.query(
      `INSERT INTO subscriptions (id, user_id, name, amount_minor, billing_frequency, anchor_date, next_billing_date, start_date, updated_at)
       VALUES ('20000000-0000-0000-0000-000000000001', $1, 'Netflix', 64900, 'monthly', '2030-01-31', '2030-01-31', '2030-01-31', '2000-01-01')`,
      [id],
    );
    await pool.query("UPDATE users SET display_name='T2' WHERE id=$1", [id]);
    await pool.query("UPDATE user_preferences SET theme='light' WHERE user_id=$1", [id]);
    await pool.query("UPDATE subscriptions SET name='Netflix 4K' WHERE user_id=$1", [id]);
    for (const [table, col] of [['users', 'id'], ['user_preferences', 'user_id'], ['subscriptions', 'user_id']] as const) {
      const r = await pool.query(`SELECT updated_at > '2020-01-01' AS bumped FROM ${table} WHERE ${col}=$1`, [id]);
      expect(r.rows[0].bumped, table).toBe(true);
    }
    await pool.query('TRUNCATE users CASCADE');
  });

  it('enforces core integrity rules at the database level', async () => {
    await pool.query('TRUNCATE users CASCADE');
    const mk = async (email: string) =>
      (await pool.query("INSERT INTO users (email, password_hash, display_name) VALUES ($1,'h','X') RETURNING id", [email])).rows[0].id as string;
    const a = await mk('a@example.com');
    const b = await mk('b@example.com');
    await expect(mk('A@EXAMPLE.COM')).rejects.toThrow(/users_email_lower_uq/);
    await pool.query(
      `INSERT INTO subscriptions (id, user_id, name, amount_minor, billing_frequency, anchor_date, next_billing_date, start_date)
       VALUES ('20000000-0000-0000-0000-000000000002', $1, 'S', 100, 'monthly', '2030-01-01', '2030-01-01', '2030-01-01')`,
      [a],
    );
    // A payment owned by user B cannot reference user A's subscription.
    await expect(
      pool.query(
        "INSERT INTO payments (user_id, subscription_id, amount_minor, currency, paid_on) VALUES ($1,'20000000-0000-0000-0000-000000000002',100,'INR','2030-01-01')",
        [b],
      ),
    ).rejects.toThrow(/payments_subscription_id_user_id_fkey/);
    // Deleting a user cascades everywhere.
    await pool.query('DELETE FROM users WHERE id=$1', [a]);
    expect((await pool.query('SELECT count(*)::int n FROM subscriptions')).rows[0].n).toBe(0);
    await pool.query('TRUNCATE users CASCADE');
  });
});

describe('migration runner (scratch database)', () => {
  const adminUrl = TEST_DB_URL.replace(/\/[^/]+$/, '/postgres');
  const scratchName = 'subcycle_migrate_scratch';
  const scratchUrl = TEST_DB_URL.replace(/\/[^/]+$/, `/${scratchName}`);
  let tmp: string;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratchName}`);
    await admin.query(`CREATE DATABASE ${scratchName}`);
    await admin.end();
    tmp = mkdtempSync(path.join(tmpdir(), 'subcycle-mig-'));
    copyFileSync(path.join(defaultMigrationsDir, '0001_init.sql'), path.join(tmp, '0001_init.sql'));
  });
  afterAll(async () => {
    rmSync(tmp, { recursive: true, force: true });
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratchName}`);
    await admin.end();
  });

  it('applies on an empty database, detects edited migrations, rolls back failed ones, and applies new ones', async () => {
    const p = createPool(scratchUrl);
    try {
      expect(await migrate(p, tmp)).toEqual(['0001_init.sql']);
      expect(await migrate(p, tmp)).toEqual([]);

      // Editing an applied migration is refused.
      const file = path.join(tmp, '0001_init.sql');
      const original = readFileSync(file, 'utf8');
      writeFileSync(file, original + '\n-- tampered\n');
      await expect(migrate(p, tmp)).rejects.toThrow(/checksum mismatch/);
      writeFileSync(file, original);

      // A failing migration leaves no partial effect and is not recorded.
      writeFileSync(path.join(tmp, '0002_bad.sql'), 'CREATE TABLE half_done (id int); SELECT 1/0;');
      await expect(migrate(p, tmp)).rejects.toThrow(/0002_bad.sql failed/);
      expect((await p.query("SELECT to_regclass('half_done') AS t")).rows[0].t).toBeNull();
      expect((await p.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n).toBe(1);

      // Replace it with a good one.
      rmSync(path.join(tmp, '0002_bad.sql'));
      writeFileSync(path.join(tmp, '0002_ok.sql'), 'CREATE TABLE ok_table (id int);');
      expect(await migrate(p, tmp)).toEqual(['0002_ok.sql']);
    } finally {
      await p.end();
    }
  });
});
