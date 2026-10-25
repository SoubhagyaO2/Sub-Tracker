import {
  DEFAULT_CALENDAR_DAYS,
  MAX_CALENDAR_OCCURRENCES,
  MAX_CALENDAR_RANGE_DAYS,
  addDays,
  collectOccurrences,
  diffDays,
  maxDate,
  renewalTotals,
  type BillingFrequency,
  type CalendarOccurrence,
  type CalendarResponseMeta,
  type CalendarSub,
  type Category,
  type CurrencyCode,
  type DateOnly,
  type SubscriptionStatus,
} from '@subcycle/shared';
import type { Queryable } from '../db/pool.js';
import { validationError } from './subscriptions.js';

export interface SubRow {
  id: string;
  name: string;
  category: Category;
  icon_kind: 'none' | 'glyph' | 'emoji';
  icon_value: string | null;
  amount_minor: number;
  currency: CurrencyCode;
  billing_frequency: BillingFrequency;
  status: SubscriptionStatus;
  anchor_date: DateOnly;
  next_billing_date: DateOnly;
  trial_end_date: DateOnly | null;
}

export const toCalendarSub = (r: SubRow): CalendarSub => ({
  id: r.id, name: r.name, category: r.category,
  icon: r.icon_kind === 'none' || r.icon_value === null ? null : { kind: r.icon_kind, value: r.icon_value },
  amountMinor: r.amount_minor, currency: r.currency, billingFrequency: r.billing_frequency, status: r.status,
  anchorDate: r.anchor_date, nextBillingDate: r.next_billing_date, trialEndDate: r.trial_end_date,
});

/** The subscriptions that can produce projected occurrences. Scoped to the user; read-only. */
export async function loadBillableSubs(db: Queryable, userId: string): Promise<CalendarSub[]> {
  const { rows } = await db.query<SubRow>(
    `SELECT id, name, category, icon_kind, icon_value, amount_minor, currency, billing_frequency, status,
            anchor_date, next_billing_date, trial_end_date
       FROM subscriptions WHERE user_id = $1 AND status IN ('active', 'trial') ORDER BY id`,
    [userId],
  );
  return rows.map(toCalendarSub);
}

/**
 * Projected occurrences for [from, to] (inclusive). READ-ONLY: nothing is written and nothing is inferred; occurrences
 * are the anchor schedule projected forward from today, never a record that anything was charged.
 * `from` is raised to today (SubCycle does not know what happened on past dates), the range is capped at
 * MAX_CALENDAR_RANGE_DAYS, and at most MAX_CALENDAR_OCCURRENCES are returned (the earliest; `truncated` says so).
 */
export async function getCalendar(
  db: Queryable,
  userId: string,
  query: { from?: DateOnly; to?: DateOnly },
  today: DateOnly,
  timeZone: string,
): Promise<{ occurrences: CalendarOccurrence[]; meta: CalendarResponseMeta }> {
  const requestedFrom = query.from ?? today;
  const to = query.to ?? addDays(requestedFrom, DEFAULT_CALENDAR_DAYS - 1);
  if (to < requestedFrom) throw validationError([{ path: 'to', message: '`to` must not be before `from`.' }]);
  if (diffDays(to, requestedFrom) + 1 > MAX_CALENDAR_RANGE_DAYS) {
    throw validationError([{ path: 'to', message: `The range can span at most ${MAX_CALENDAR_RANGE_DAYS} days.` }]);
  }

  const from = maxDate(requestedFrom, today);
  const subs = await loadBillableSubs(db, userId);
  const all = from <= to ? collectOccurrences(subs, { from, to }, today) : [];
  return {
    occurrences: all.slice(0, MAX_CALENDAR_OCCURRENCES),
    meta: {
      from, to, today, timeZone, kind: 'projection', total: all.length, truncated: all.length > MAX_CALENDAR_OCCURRENCES,
      totals: renewalTotals(all), trialEndCount: all.filter((o) => o.kind === 'trial_end').length,
    },
  };
}
