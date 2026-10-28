#!/usr/bin/env node
// Proves that a SubCycle database can be backed up with pg_dump and restored with pg_restore, using ONLY disposable
// databases created (and dropped) by this script. It never reads or writes any database it did not create.
//
//   node scripts/verify-backup-restore.mjs
//
// Environment (all optional):
//   BACKUP_CHECK_CONTAINER  docker container running PostgreSQL        (default: subtrack-postgres)
//   BACKUP_CHECK_USER       superuser / createdb role                  (default: subcycle)
//   BACKUP_CHECK_PASSWORD   its password                               (default: subcycle)
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dumpPathFor, safeDatabaseName as safe } from './backup-guard.mjs';

const container = process.env.BACKUP_CHECK_CONTAINER ?? 'subtrack-postgres';
const user = process.env.BACKUP_CHECK_USER ?? 'subcycle';
const password = process.env.BACKUP_CHECK_PASSWORD ?? 'subcycle';
const run = randomBytes(4).toString('hex');
const SRC = `restore_check_src_${run}`;
const DST = `restore_check_dst_${run}`;
const DUMP = dumpPathFor(SRC);

const docker = (args, input) =>
  execFileSync('docker', ['exec', '-i', '-e', `PGPASSWORD=${password}`, container, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
const psql = (db, sql) => docker(['psql', '-U', user, '-d', safe(db), '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]).trim();
const admin = (sql) => docker(['psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

try {
  admin(`CREATE DATABASE ${safe(SRC)}`);
  const migrations = path.resolve(import.meta.dirname, '../apps/api/migrations');
  for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
    docker(['psql', '-U', user, '-d', safe(SRC), '-v', 'ON_ERROR_STOP=1', '-q'], readFileSync(path.join(migrations, file), 'utf8'));
  }

  // Representative data: one user with preferences, a subscription, two payments, price history and a reminder.
  psql(SRC, `
    WITH u AS (INSERT INTO users (email, password_hash, display_name) VALUES ('restore-check@example.com', 'not-a-real-hash', 'Restore Check') RETURNING id),
         p AS (INSERT INTO user_preferences (user_id, currency, timezone, theme) SELECT id, 'USD', 'Pacific/Auckland', 'light' FROM u),
         s AS (INSERT INTO subscriptions (user_id, name, category, amount_minor, currency, billing_frequency, anchor_date, next_billing_date, start_date)
               SELECT id, 'Backup TV', 'video', 64900, 'INR', 'monthly', '2030-02-28', '2030-02-28', '2030-01-01' FROM u RETURNING id, user_id),
         pay AS (INSERT INTO payments (user_id, subscription_id, amount_minor, currency, paid_on, status, for_billing_date)
                 SELECT user_id, id, 64900, 'INR', '2030-01-28'::date, 'paid', '2030-01-28'::date FROM s UNION ALL
                 SELECT user_id, id, 100, 'INR', '2030-01-29'::date, 'refunded', NULL::date FROM s)
    INSERT INTO reminders (user_id, subscription_id, kind, channel, target_date, lead_days, remind_at, status, sent_at)
    SELECT user_id, id, 'renewal', 'in_app', '2030-02-28'::date, 3, '2030-02-25T09:00:00Z'::timestamptz, 'sent', '2030-02-25T09:00:01Z'::timestamptz FROM s;
  `);

  const TABLES = ['users', 'user_preferences', 'sessions', 'subscriptions', 'payments', 'subscription_price_history', 'reminders', 'email_verification_tokens'];
  const fingerprint = (db) =>
    Object.fromEntries(
      TABLES.map((t) => [t, psql(db, `SELECT count(*) || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') FROM ${t} x`)]),
    );

  const before = fingerprint(SRC);
  docker(['pg_dump', '-Fc', '-U', user, '-d', safe(SRC), '-f', DUMP]);
  check('pg_dump produced a custom-format archive', docker(['sh', '-c', `test -s ${DUMP} && echo yes`]).trim() === 'yes');

  admin(`CREATE DATABASE ${safe(DST)}`);
  docker(['pg_restore', '-U', user, '-d', safe(DST), '--no-owner', '--exit-on-error', DUMP]);
  const after = fingerprint(DST);

  for (const t of TABLES) check(`table ${t}: row count and content checksum identical`, before[t] === after[t], before[t].split(':')[0] + ' rows');
  check('the data is not trivially empty', Number(before.payments.split(':')[0]) === 2 && Number(before.users.split(':')[0]) === 1);

  // Constraints, triggers and indexes must have come back, not just rows.
  const dupe = (() => {
    try {
      psql(DST, `INSERT INTO payments (user_id, subscription_id, amount_minor, currency, paid_on, status, for_billing_date)
                 SELECT user_id, subscription_id, 1, 'INR', '2030-01-30', 'paid', '2030-01-28' FROM payments WHERE status = 'paid'`);
      return false;
    } catch {
      return true; // the duplicate-billing-period guard rejected it
    }
  })();
  check('restored database still enforces the duplicate-payment-period guard', dupe);
  check('restored database still has the updated_at triggers', Number(psql(DST, "SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%set_updated_at' AND NOT tgisinternal")) >= 4);
  check('restored database has the same indexes', psql(SRC, "SELECT count(*) FROM pg_indexes WHERE schemaname='public'") === psql(DST, "SELECT count(*) FROM pg_indexes WHERE schemaname='public'"));
  check('cascade still works after restore (deleting the user removes everything)', (() => {
    psql(DST, "DELETE FROM users WHERE email = 'restore-check@example.com'");
    return psql(DST, 'SELECT (SELECT count(*) FROM payments) + (SELECT count(*) FROM subscriptions) + (SELECT count(*) FROM reminders) + (SELECT count(*) FROM user_preferences)') === '0';
  })());
} catch (err) {
  failures.push('script error');
  console.error('ERROR', String(err.stderr || err.message).split('\n').slice(0, 5).join('\n'));
} finally {
  for (const db of [DST, SRC]) {
    try {
      admin(`DROP DATABASE IF EXISTS ${safe(db)}`);
    } catch {
      console.error(`WARNING: could not drop ${db}; drop it manually`);
    }
  }
  try {
    docker(['rm', '-f', DUMP]);
  } catch {
    /* best effort */
  }
}
console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nbackup and restore verified on disposable databases');
process.exit(failures.length ? 1 : 0);
