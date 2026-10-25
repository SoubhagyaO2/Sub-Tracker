import {
  compareDates,
  nextOccurrences,
  rollForwardDate,
  type CurrencyCode,
  type DateOnly,
} from '@subcycle/shared';
import type { Clock } from '../clock.js';
import type { Pool, Queryable } from '../db/pool.js';
import { todayInZone } from '../today.js';
import { findOwned } from './subscriptions.js';

export interface UpcomingOccurrence {
  date: DateOnly;
  amountMinor: number;
  currency: CurrencyCode;
}

/**
 * Projected future billing dates from the subscription's anchor schedule, at the CURRENT price.
 * A projection, not a record: read-only, creates nothing, and touches only the one subscription asked for.
 * - active: from the upcoming date (stored date rolled forward to today)
 * - trial: only while the trial end date has not passed (a trial is never auto-converted)
 * - paused / cancelled / archived: none
 */
export async function getUpcoming(
  db: Queryable,
  userId: string,
  subscriptionId: string,
  count: number,
  today: DateOnly,
): Promise<UpcomingOccurrence[]> {
  const s = await findOwned(db, userId, subscriptionId);
  let from: DateOnly | null = null;
  if (s.status === 'active') from = rollForwardDate(s.anchor_date, s.billing_frequency, s.next_billing_date, today);
  else if (s.status === 'trial' && compareDates(s.next_billing_date, today) >= 0) from = s.next_billing_date;
  if (from === null) return [];
  return nextOccurrences(s.anchor_date, s.billing_frequency, from, count).map((date) => ({
    date,
    amountMinor: s.amount_minor,
    currency: s.currency,
  }));
}

interface StaleRow {
  id: string;
  user_id: string;
  anchor_date: DateOnly;
  billing_frequency: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  next_billing_date: DateOnly;
  timezone: string;
}

const BATCH = 500;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Persists the roll-forward for ACTIVE subscriptions whose stored next billing date is before the owner's
 * "today" (each user's own time zone). Run by a background job, never by a read request.
 * - moves along the anchor's schedule (no drift) and never backwards;
 * - creates NO payment records;
 * - trials are not rolled (they are never auto-converted); paused/cancelled/archived do not bill;
 * - each row is updated only if it still holds the value that was read, so a concurrent user edit wins;
 * - `userId` restricts it to one user's rows.
 * Returns the number of subscriptions updated.
 */
export async function rollForwardStale(db: Pool, clock: Clock, opts: { userId?: string } = {}): Promise<number> {
  // Cheap superset filter in UTC (the furthest-ahead zone is UTC+14, so "stale" implies next <= UTC date);
  // the exact per-user comparison happens below in each user's own zone.
  const utcDate = clock.now().toISOString().slice(0, 10);
  const todayByZone = new Map<string, DateOnly | null>();
  const zoneToday = (tz: string): DateOnly | null => {
    if (!todayByZone.has(tz)) {
      try {
        todayByZone.set(tz, todayInZone(clock, tz));
      } catch {
        todayByZone.set(tz, null); // an unusable stored zone must not stop everyone else's roll-forward
      }
    }
    return todayByZone.get(tz)!;
  };

  let updated = 0;
  let lastId = NIL_UUID;
  for (;;) {
    const { rows } = await db.query<StaleRow>(
      `SELECT s.id, s.user_id, s.anchor_date, s.billing_frequency, s.next_billing_date, p.timezone
         FROM subscriptions s
         JOIN user_preferences p ON p.user_id = s.user_id
        WHERE s.status = 'active'
          AND s.next_billing_date <= $1::date
          AND s.id > $2::uuid
          AND ($3::uuid IS NULL OR s.user_id = $3::uuid)
        ORDER BY s.id
        LIMIT $4`,
      [utcDate, lastId, opts.userId ?? null, BATCH],
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      const today = zoneToday(r.timezone);
      if (today === null || compareDates(r.next_billing_date, today) >= 0) continue;
      const next = rollForwardDate(r.anchor_date, r.billing_frequency, r.next_billing_date, today);
      const res = await db.query(
        `UPDATE subscriptions SET next_billing_date = $3
          WHERE id = $1 AND user_id = $2 AND status = 'active' AND next_billing_date = $4::date`,
        [r.id, r.user_id, next, r.next_billing_date],
      );
      updated += res.rowCount ?? 0;
    }
    lastId = rows[rows.length - 1]!.id;
  }
  return updated;
}
