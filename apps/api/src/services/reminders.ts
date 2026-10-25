import {
  dateInZone,
  planReminders,
  reminderKey,
  zonedInstant,
  type CurrencyCode,
  type DateOnly,
  type ListRemindersQuery,
  type ReminderChannel,
  type ReminderDto,
  type ReminderKind,
  type ReminderPrefs,
  type ReminderStatus,
  type ReminderSub,
  type SkipReason,
  type BillingFrequency,
  type SubscriptionStatus,
} from '@subcycle/shared';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import { withTransaction, type Pool, type Queryable } from '../db/pool.js';
import { notFound } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Mailer } from '../mail/mailer.js';
import { buildReminderEmail } from '../mail/reminderEmail.js';

export interface ReminderEnv {
  pool: Pool;
  clock: Clock;
  mailer: Mailer;
  config: Config;
  logger: Logger;
}

// ═════════════ generation: keep the set of pending reminders equal to what the schedule says should exist ═════════════

export interface ReconcileResult {
  /** True when the user's stored time zone is unusable: nothing could be planned for them. */
  invalidTimeZone: boolean;
  created: number;
  revived: number;
  rescheduled: number;
  superseded: number;
  expiredMissed: number;
}
const EMPTY: ReconcileResult = { invalidTimeZone: false, created: 0, revived: 0, rescheduled: 0, superseded: 0, expiredMissed: 0 };

interface PrefsRow {
  timezone: string;
  reminder_lead_days: number;
  reminder_hour: number;
  in_app_reminders: boolean;
  email_reminders_enabled: boolean;
  trial_reminders_enabled: boolean;
  email_verified_at: Date | null;
}
interface PlanSubRow {
  id: string;
  status: SubscriptionStatus;
  billing_frequency: BillingFrequency;
  anchor_date: DateOnly;
  next_billing_date: DateOnly;
  trial_end_date: DateOnly | null;
  reminder_lead_days: number | null;
  reminders_enabled: boolean;
}
interface PendingRow {
  id: string;
  subscription_id: string;
  kind: ReminderKind;
  channel: ReminderChannel;
  target_date: DateOnly;
  lead_days: number;
  remind_at: Date;
}

/** Skipped because email wasn't deliverable at the time. If that has since been fixed, the reminder can still be sent. */
const REVIVABLE_EMAIL_SKIPS: SkipReason[] = ['smtp_not_configured', 'email_not_verified', 'email_disabled'];

/**
 * Brings ONE user's reminders in line with their subscriptions and settings. Idempotent and safe to run concurrently
 * (serialised per user by an advisory transaction lock; inserts are also protected by the table's unique constraint):
 *  1. pending reminders whose renewal date has already passed are marked skipped("delivery_window_missed"): they were
 *     never delivered, and are NOT delivered late and NOT recorded as sent;
 *  2. missing reminders are inserted (ON CONFLICT DO NOTHING); superseded ones whose key is wanted again are revived;
 *     email reminders skipped only because email wasn't deliverable are revived once it is;
 *  3. pending reminders that are no longer wanted (paused, cancelled, paid ahead, lead changed, channel off...) are
 *     marked superseded; ones whose time merely moved (hour or zone change) are rescheduled.
 * It never touches sent, failed, or other skipped rows, and never touches payments.
 */
export async function reconcileUserReminders(env: Pick<ReminderEnv, 'pool' | 'clock' | 'mailer'>, userId: string): Promise<ReconcileResult> {
  const { pool, clock, mailer } = env;
  const prefsRes = await pool.query<PrefsRow>(
    `SELECT p.timezone, p.reminder_lead_days, p.reminder_hour, p.in_app_reminders, p.email_reminders_enabled,
            p.trial_reminders_enabled, u.email_verified_at
       FROM user_preferences p JOIN users u ON u.id = p.user_id WHERE p.user_id = $1`,
    [userId],
  );
  const pr = prefsRes.rows[0];
  if (!pr) return { ...EMPTY };

  const prefs: ReminderPrefs = {
    timeZone: pr.timezone, leadDays: pr.reminder_lead_days, hour: pr.reminder_hour,
    inApp: pr.in_app_reminders, email: pr.email_reminders_enabled, trial: pr.trial_reminders_enabled,
  };
  let today: DateOnly;
  try {
    today = dateInZone(clock.now(), prefs.timeZone);
    zonedInstant(today, prefs.hour, prefs.timeZone);
  } catch {
    return { ...EMPTY, invalidTimeZone: true };
  }
  const emailDeliverable = mailer.configured && pr.email_verified_at !== null && prefs.email;

  return withTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 7))', [`reminders:${userId}`]);
    const result: ReconcileResult = { ...EMPTY };

    const expired = await tx.query(
      `UPDATE reminders SET status = 'skipped', skip_reason = 'delivery_window_missed', next_attempt_at = NULL
        WHERE user_id = $1 AND status = 'pending' AND target_date < $2::date`,
      [userId, today],
    );
    result.expiredMissed = expired.rowCount ?? 0;

    const subsRes = await tx.query<PlanSubRow>(
      `SELECT id, status, billing_frequency, anchor_date, next_billing_date, trial_end_date, reminder_lead_days, reminders_enabled
         FROM subscriptions WHERE user_id = $1 AND status IN ('active', 'trial') ORDER BY id`,
      [userId],
    );
    const subs: ReminderSub[] = subsRes.rows.map((s) => ({
      id: s.id, status: s.status, billingFrequency: s.billing_frequency, anchorDate: s.anchor_date,
      nextBillingDate: s.next_billing_date, trialEndDate: s.trial_end_date, reminderLeadDays: s.reminder_lead_days,
      remindersEnabled: s.reminders_enabled,
    }));
    // Deterministic order: concurrent reconciles of the same user would otherwise lock rows in different orders.
    // A renewal the user was ALREADY reminded about (on that channel) is not reminded about again just because the lead
    // time changed afterwards: the lead time is part of the uniqueness key, so without this a new row would be planned.
    const alreadyNotified = new Set(
      (
        await tx.query<{ subscription_id: string; kind: string; target_date: string; channel: string }>(
          `SELECT subscription_id, kind, target_date::text AS target_date, channel FROM reminders
            WHERE user_id = $1 AND status = 'sent' AND target_date >= $2::date`,
          [userId, today],
        )
      ).rows.map((r) => `${r.subscription_id}|${r.kind}|${r.target_date}|${r.channel}`),
    );
    const plan = planReminders(subs, prefs, today)
      .filter((p) => !alreadyNotified.has(`${p.subscriptionId}|${p.kind}|${p.targetDate}|${p.channel}`))
      .sort((a, b) => reminderKey(a).localeCompare(reminderKey(b)));
    const wanted = new Map(plan.map((p) => [reminderKey(p), p]));

    const pending = (
      await tx.query<PendingRow>(
        `SELECT id, subscription_id, kind, channel, target_date, lead_days, remind_at FROM reminders
          WHERE user_id = $1 AND status = 'pending' ORDER BY id`,
        [userId],
      )
    ).rows;
    const pendingByKey = new Map(
      pending.map((r) => [reminderKey({ subscriptionId: r.subscription_id, kind: r.kind, targetDate: r.target_date, leadDays: r.lead_days, channel: r.channel }), r]),
    );

    // 3a. no longer wanted -> superseded
    const stale = pending.filter((r) => !wanted.has(reminderKey({ subscriptionId: r.subscription_id, kind: r.kind, targetDate: r.target_date, leadDays: r.lead_days, channel: r.channel })));
    if (stale.length) {
      const res = await tx.query(`UPDATE reminders SET status = 'superseded', next_attempt_at = NULL WHERE id = ANY($1::uuid[]) AND status = 'pending'`, [stale.map((r) => r.id)]);
      result.superseded = res.rowCount ?? 0;
    }

    // 3b. wanted and pending, but at a different instant (reminder hour or zone changed) -> reschedule
    const moved = plan.filter((p) => {
      const cur = pendingByKey.get(reminderKey(p));
      return cur !== undefined && cur.remind_at.getTime() !== p.remindAt.getTime();
    });
    if (moved.length) {
      const res = await tx.query(
        `UPDATE reminders r SET remind_at = v.at
           FROM unnest($1::uuid[], $2::timestamptz[]) AS v(id, at)
          WHERE r.id = v.id AND r.status = 'pending'`,
        [moved.map((p) => pendingByKey.get(reminderKey(p))!.id), moved.map((p) => p.remindAt)],
      );
      result.rescheduled = res.rowCount ?? 0;
    }

    // 2a. wanted but not pending -> insert (or revive a superseded row with the same key)
    const toInsert = plan.filter((p) => !pendingByKey.has(reminderKey(p)));
    if (toInsert.length) {
      const res = await tx.query<{ inserted: boolean }>(
        `INSERT INTO reminders (user_id, subscription_id, kind, channel, target_date, lead_days, remind_at)
         SELECT $1, t.sid, t.kind, t.channel, t.target, t.lead, t.at
           FROM unnest($2::uuid[], $3::text[], $4::text[], $5::date[], $6::int[], $7::timestamptz[]) AS t(sid, kind, channel, target, lead, at)
         ON CONFLICT ON CONSTRAINT reminders_unique_per_renewal
         DO UPDATE SET status = 'pending', remind_at = EXCLUDED.remind_at, attempts = 0, next_attempt_at = NULL, last_error = NULL, skip_reason = NULL
           WHERE reminders.status = 'superseded'
         RETURNING (xmax = 0) AS inserted`,
        [userId, toInsert.map((p) => p.subscriptionId), toInsert.map((p) => p.kind), toInsert.map((p) => p.channel), toInsert.map((p) => p.targetDate), toInsert.map((p) => p.leadDays), toInsert.map((p) => p.remindAt)],
      );
      result.created = res.rows.filter((r) => r.inserted).length;
      result.revived += res.rows.filter((r) => !r.inserted).length;
    }

    // 2b. email reminders skipped only because email couldn't be sent, now that it can be
    if (emailDeliverable) {
      const res = await tx.query(
        `UPDATE reminders SET status = 'pending', skip_reason = NULL, attempts = 0, next_attempt_at = NULL, last_error = NULL
          WHERE user_id = $1 AND channel = 'email' AND status = 'skipped' AND skip_reason = ANY($2::text[]) AND target_date >= $3::date
            AND (subscription_id::text || '|' || kind || '|' || target_date::text || '|' || lead_days::text || '|email') = ANY($4::text[])`,
        [userId, REVIVABLE_EMAIL_SKIPS, today, plan.filter((p) => p.channel === 'email').map((p) => reminderKey(p))],
      );
      result.revived += res.rowCount ?? 0;
    }
    return result;
  });
}

/** Users who might need reconciling: those with an active/trial subscription or a pending reminder. */
export async function reconcileAllReminders(env: ReminderEnv, opts: { batch?: number } = {}): Promise<ReconcileResult & { users: number; usersWithInvalidTimeZone: number }> {
  const total = { ...EMPTY, users: 0, usersWithInvalidTimeZone: 0 };
  let last = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { rows } = await env.pool.query<{ id: string }>(
      `SELECT u.id FROM users u
        WHERE u.id > $1::uuid
          AND (EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status IN ('active', 'trial'))
               OR EXISTS (SELECT 1 FROM reminders r WHERE r.user_id = u.id AND r.status = 'pending'))
        ORDER BY u.id LIMIT $2`,
      [last, opts.batch ?? 200],
    );
    if (rows.length === 0) break;
    for (const { id } of rows) {
      try {
        const r = await reconcileUserReminders(env, id);
        total.users += 1;
        if (r.invalidTimeZone) total.usersWithInvalidTimeZone += 1;
        total.created += r.created;
        total.revived += r.revived;
        total.rescheduled += r.rescheduled;
        total.superseded += r.superseded;
        total.expiredMissed += r.expiredMissed;
      } catch (err) {
        // One user's failure (e.g. a lock timeout) must not stop everyone else's reminders.
        env.logger.error({ event: 'reminder_reconcile_failed', userId: id, errorName: (err as Error).name, errorCode: (err as { code?: string }).code }, 'reconcile failed for one user');
      }
      last = id;
    }
  }
  return total;
}

// ═════════════ delivery ═════════════

export interface DeliveryResult {
  claimed: number;
  inAppSent: number;
  emailSent: number;
  emailSkipped: number;
  emailFailed: number;
  retryScheduled: number;
  superseded: number;
  missed: number;
  invalidTimeZone: number;
  errors: number;
}

interface ClaimedRow {
  id: string;
  user_id: string;
  subscription_id: string;
  kind: ReminderKind;
  channel: ReminderChannel;
  target_date: DateOnly;
  lead_days: number;
  attempts: number;
  email: string;
  email_verified_at: Date | null;
  timezone: string;
  in_app_reminders: boolean;
  email_reminders_enabled: boolean;
  trial_reminders_enabled: boolean;
  name: string;
  amount_minor: number;
  currency: CurrencyCode;
  sub_status: SubscriptionStatus;
  reminders_enabled: boolean;
}

/** A short, safe label for logs and the UI: never provider text, addresses or credentials. */
export function classifySendError(err: unknown): { permanent: boolean; label: string } {
  const responseCode = (err as { responseCode?: unknown }).responseCode;
  if (typeof responseCode === 'number') return { permanent: responseCode >= 500 && responseCode < 600, label: `SMTP ${responseCode}` };
  const code = (err as { code?: unknown }).code;
  const safe = typeof code === 'string' && /^[A-Z0-9_]{2,20}$/.test(code) ? code : null;
  return { permanent: false, label: safe ? `SMTP ${safe}` : 'SMTP error' };
}

/**
 * Delivers every due reminder exactly as the state allows.
 *  - Claiming sets a lease (`next_attempt_at`) under FOR UPDATE SKIP LOCKED, so concurrent workers never claim the same row.
 *  - In-app: marked sent (= visible in the inbox). Email: sent only if SMTP is configured, the user enabled it and verified the
 *    address; otherwise recorded as skipped WITH the reason. A reminder is `sent` only after the provider accepted the message.
 *  - SMTP failures: permanent (5xx) -> failed; temporary -> retried with backoff, failed after the attempt limit.
 *  - A reminder whose renewal date has passed is skipped("delivery_window_missed"), never delivered late.
 *  - Email is AT-LEAST-ONCE: if the process dies after the provider accepted a message but before the row is marked sent,
 *    the lease expires and the reminder is sent again. This window is small but real, and documented.
 */
export async function deliverDueReminders(env: ReminderEnv, opts: { maxBatches?: number } = {}): Promise<DeliveryResult> {
  const { pool, clock, config, logger } = env;
  const result: DeliveryResult = { claimed: 0, inAppSent: 0, emailSent: 0, emailSkipped: 0, emailFailed: 0, retryScheduled: 0, superseded: 0, missed: 0, invalidTimeZone: 0, errors: 0 };

  for (let batch = 0; batch < (opts.maxBatches ?? 20); batch++) {
    const now = clock.now();
    const claimed = await pool.query<{ id: string }>(
      `WITH due AS (
         SELECT id FROM reminders
          WHERE status = 'pending' AND remind_at <= $1 AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
          ORDER BY remind_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
       UPDATE reminders r SET attempts = r.attempts + 1, next_attempt_at = $3
         FROM due WHERE r.id = due.id RETURNING r.id`,
      [now, config.scheduler.claimBatch, new Date(now.getTime() + config.scheduler.leaseMs)],
    );
    if (claimed.rows.length === 0) break;
    result.claimed += claimed.rows.length;

    const rows = (
      await pool.query<ClaimedRow>(
        `SELECT r.id, r.user_id, r.subscription_id, r.kind, r.channel, r.target_date, r.lead_days, r.attempts,
                u.email, u.email_verified_at, p.timezone, p.in_app_reminders, p.email_reminders_enabled, p.trial_reminders_enabled,
                s.name, s.amount_minor, s.currency, s.status AS sub_status, s.reminders_enabled
           FROM reminders r
           JOIN users u ON u.id = r.user_id
           JOIN user_preferences p ON p.user_id = r.user_id
           JOIN subscriptions s ON s.id = r.subscription_id AND s.user_id = r.user_id
          WHERE r.id = ANY($1::uuid[]) ORDER BY r.remind_at, r.id`,
        [claimed.rows.map((r) => r.id)],
      )
    ).rows;

    for (const row of rows) {
      try {
        await deliverOne(env, row, result);
      } catch (err) {
        // Leave the lease in place: the row becomes due again when it expires. Log a code, never the payload.
        result.errors += 1;
        logger.error({ event: 'reminder_delivery_error', reminderId: row.id, errorName: (err as Error).name, errorCode: (err as { code?: string }).code }, 'reminder delivery error');
      }
    }
  }
  return result;
}

async function finish(db: Queryable, id: string, s: { status: ReminderStatus; reason?: SkipReason; sentAt?: Date; lastError?: string | null }): Promise<boolean> {
  const res = await db.query(
    `UPDATE reminders SET status = $2, skip_reason = $3, sent_at = $4, last_error = $5, next_attempt_at = NULL
      WHERE id = $1 AND status = 'pending'`,
    [id, s.status, s.reason ?? null, s.sentAt ?? null, s.lastError ?? null],
  );
  return (res.rowCount ?? 0) === 1;
}

async function deliverOne(env: ReminderEnv, row: ClaimedRow, out: DeliveryResult): Promise<void> {
  const { pool, clock, mailer, config, logger } = env;
  const now = clock.now();

  // Still wanted? (State can change between planning and delivery.)
  const stillApplies =
    row.reminders_enabled &&
    ((row.kind === 'renewal' && row.sub_status === 'active') || (row.kind === 'trial_end' && row.sub_status === 'trial' && row.trial_reminders_enabled)) &&
    (row.channel === 'in_app' ? row.in_app_reminders : true);
  if (!stillApplies) {
    if (await finish(pool, row.id, { status: 'superseded' })) out.superseded += 1;
    return;
  }

  let today: DateOnly;
  try {
    today = dateInZone(now, row.timezone);
  } catch {
    if (await finish(pool, row.id, { status: 'skipped', reason: 'invalid_time_zone' })) out.invalidTimeZone += 1;
    return;
  }
  if (today > row.target_date) {
    if (await finish(pool, row.id, { status: 'skipped', reason: 'delivery_window_missed' })) out.missed += 1;
    return;
  }

  if (row.channel === 'in_app') {
    if (await finish(pool, row.id, { status: 'sent', sentAt: now })) out.inAppSent += 1;
    return;
  }

  // ── email: every precondition is checked, and each failure is recorded truthfully
  const skip = async (reason: SkipReason) => {
    if (await finish(pool, row.id, { status: 'skipped', reason })) out.emailSkipped += 1;
  };
  if (!row.email_reminders_enabled) return skip('email_disabled');
  if (!mailer.configured) return skip('smtp_not_configured');
  if (row.email_verified_at === null) return skip('email_not_verified');

  const message = buildReminderEmail({
    kind: row.kind, name: row.name, targetDate: row.target_date, today, amountMinor: row.amount_minor,
    currency: row.currency, appUrl: config.appUrl, subscriptionId: row.subscription_id,
  });
  try {
    await mailer.send({ to: row.email, subject: message.subject, text: message.text });
  } catch (err) {
    const { permanent, label } = classifySendError(err);
    logger.warn({ event: 'reminder_email_failed', reminderId: row.id, label, permanent, attempts: row.attempts }, 'reminder email failed');
    if (permanent || row.attempts >= config.scheduler.maxAttempts) {
      if (await finish(pool, row.id, { status: 'failed', lastError: label })) out.emailFailed += 1;
      return;
    }
    const wait = config.scheduler.backoffMinutes[Math.min(row.attempts, config.scheduler.backoffMinutes.length) - 1] ?? 360;
    await pool.query(`UPDATE reminders SET next_attempt_at = $2, last_error = $3 WHERE id = $1 AND status = 'pending'`, [row.id, new Date(now.getTime() + wait * 60_000), label]);
    out.retryScheduled += 1;
    return;
  }
  // The provider accepted the message: only now is the reminder "sent".
  if (await finish(pool, row.id, { status: 'sent', sentAt: now })) out.emailSent += 1;
}

// ═════════════ the user's view: inbox and delivery log ═════════════

interface ReminderRow {
  id: string;
  subscription_id: string;
  subscription_name: string;
  kind: ReminderKind;
  channel: ReminderChannel;
  target_date: DateOnly;
  lead_days: number;
  remind_at: Date;
  status: ReminderStatus;
  skip_reason: SkipReason | null;
  attempts: number;
  sent_at: Date | null;
  read_at: Date | null;
  last_error: string | null;
}

const toDto = (r: ReminderRow): ReminderDto => ({
  id: r.id, subscriptionId: r.subscription_id, subscriptionName: r.subscription_name, kind: r.kind, channel: r.channel,
  targetDate: r.target_date, leadDays: r.lead_days, remindAt: r.remind_at.toISOString(), status: r.status, skipReason: r.skip_reason,
  attempts: r.attempts, sentAt: r.sent_at?.toISOString() ?? null, readAt: r.read_at?.toISOString() ?? null, lastError: r.last_error,
});

const SELECT = `SELECT r.id, r.subscription_id, s.name AS subscription_name, r.kind, r.channel, r.target_date, r.lead_days, r.remind_at,
                       r.status, r.skip_reason, r.attempts, r.sent_at, r.read_at, r.last_error
                  FROM reminders r JOIN subscriptions s ON s.id = r.subscription_id AND s.user_id = r.user_id`;

/** Read-only. Every row is scoped by user_id, and the subscription join re-checks ownership. */
export async function listReminders(
  db: Queryable,
  userId: string,
  q: ListRemindersQuery,
): Promise<{ items: ReminderDto[]; total: number; unread: number; page: number; pageSize: number }> {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 25;
  const params: unknown[] = [userId];
  const where = ['r.user_id = $1'];
  const bind = (v: unknown) => (params.push(v), `$${params.length}`);
  if (q.channel) where.push(`r.channel = ${bind(q.channel)}`);
  if (q.status) where.push(`r.status = ANY(${bind(q.status)}::text[])`);
  if (q.unread) where.push(`r.channel = 'in_app' AND r.status = 'sent' AND r.read_at IS NULL`);
  const whereSql = where.join(' AND ');

  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM reminders r WHERE ${whereSql}`, params)).rows[0]!.n;
  const unread = (
    await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM reminders WHERE user_id = $1 AND channel = 'in_app' AND status = 'sent' AND read_at IS NULL`, [userId])
  ).rows[0]!.n;
  const limit = bind(pageSize);
  const offset = bind((page - 1) * pageSize);
  const { rows } = await db.query<ReminderRow>(`${SELECT} WHERE ${whereSql} ORDER BY r.remind_at DESC, r.id DESC LIMIT ${limit} OFFSET ${offset}`, params);
  return { items: rows.map(toDto), total, unread, page, pageSize };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Marks one DELIVERED in-app reminder as read. Idempotent. Anything else (another user's, undelivered, email) is "not found". */
export async function dismissReminder(db: Queryable, userId: string, id: string, now: Date): Promise<ReminderDto> {
  if (!UUID_RE.test(id)) throw notFound('Reminder not found.');
  const upd = await db.query(
    `UPDATE reminders SET read_at = COALESCE(read_at, $3) WHERE id = $1 AND user_id = $2 AND channel = 'in_app' AND status = 'sent'`,
    [id, userId, now],
  );
  if (upd.rowCount === 0) throw notFound('Reminder not found.');
  const { rows } = await db.query<ReminderRow>(`${SELECT} WHERE r.id = $1 AND r.user_id = $2`, [id, userId]);
  return toDto(rows[0]!);
}

