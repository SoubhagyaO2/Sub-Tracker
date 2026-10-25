import { z } from 'zod';
import type { Category } from './subscription.js';
import { MAX_YEAR, MIN_YEAR } from './subscription.js';
import { compareDates, diffDays, isValidDateOnly, parseDateOnly, type BillingFrequency, type DateOnly } from './dates.js';
import type { CurrencyCode } from './currency.js';
import { maxDate, occurrencesBetween } from './recurrence.js';
import type { SubscriptionStatus } from './status.js';

export const MAX_CALENDAR_RANGE_DAYS = 366;
export const MAX_CALENDAR_OCCURRENCES = 1000;
export const DEFAULT_CALENDAR_DAYS = 30;

const dateOnly = z
  .string()
  .refine(isValidDateOnly, 'Use a valid calendar date in YYYY-MM-DD format.')
  .refine((s) => {
    const p = parseDateOnly(s);
    return p !== null && p.y >= MIN_YEAR && p.y <= MAX_YEAR;
  }, `Year must be between ${MIN_YEAR} and ${MAX_YEAR}.`);

/** Both bounds are inclusive. Omitted bounds default to "today" and 30 days after `from`; resolved server-side. */
export const calendarQuerySchema = z
  .strictObject({ from: dateOnly.optional(), to: dateOnly.optional() })
  .superRefine((q, ctx) => {
    if (q.from && q.to) {
      if (compareDates(q.to, q.from) < 0) ctx.addIssue({ code: 'custom', path: ['to'], message: '`to` must not be before `from`.' });
      else if (diffDays(q.to, q.from) + 1 > MAX_CALENDAR_RANGE_DAYS) {
        ctx.addIssue({ code: 'custom', path: ['to'], message: `The range can span at most ${MAX_CALENDAR_RANGE_DAYS} days.` });
      }
    }
  });

export interface CalendarSub {
  id: string;
  name: string;
  category: Category;
  icon: { kind: 'glyph' | 'emoji'; value: string } | null;
  amountMinor: number;
  currency: CurrencyCode;
  billingFrequency: BillingFrequency;
  status: SubscriptionStatus;
  anchorDate: DateOnly;
  nextBillingDate: DateOnly;
  trialEndDate: DateOnly | null;
}

export interface CalendarOccurrence {
  date: DateOnly;
  /** "renewal": a billing date of an active subscription (a PROJECTION: never a record that a charge happened). */
  kind: 'renewal' | 'trial_end';
  subscriptionId: string;
  name: string;
  category: Category;
  icon: CalendarSub['icon'];
  amountMinor: number;
  currency: CurrencyCode;
  billingFrequency: BillingFrequency;
  status: SubscriptionStatus;
}

export interface CalendarTotals {
  currency: CurrencyCode;
  renewalCount: number;
  /** Sum of the renewal charges in the range, in this currency only. Trial endings carry no charge yet. */
  amountMinor: number;
}

const PER_SUBSCRIPTION_CAP = MAX_CALENDAR_RANGE_DAYS; // a weekly subscription has at most 53 dates in 366 days

/**
 * Every projected occurrence in [from, to], pure and read-only.
 *  - active: each billing date on the anchor schedule, starting no earlier than today and no earlier than the saved
 *    next billing date (so a renewal that was paid ahead is not shown again); weekly subscriptions yield several.
 *  - trial: one "trial_end" event on the trial end date, only while that date has not passed.
 *  - paused / cancelled / archived: nothing.
 * Dates before `today` never produce occurrences: SubCycle projects forward and never infers what happened.
 */
export function collectOccurrences(subs: readonly CalendarSub[], range: { from: DateOnly; to: DateOnly }, today: DateOnly): CalendarOccurrence[] {
  const out: CalendarOccurrence[] = [];
  const base = (s: CalendarSub) => ({
    subscriptionId: s.id, name: s.name, category: s.category, icon: s.icon, amountMinor: s.amountMinor,
    currency: s.currency, billingFrequency: s.billingFrequency, status: s.status,
  });
  for (const s of subs) {
    if (s.status === 'active') {
      const start = maxDate(range.from, today, s.nextBillingDate);
      for (const date of occurrencesBetween(s.anchorDate, s.billingFrequency, start, range.to, PER_SUBSCRIPTION_CAP)) {
        out.push({ date, kind: 'renewal', ...base(s) });
      }
    } else if (s.status === 'trial') {
      const date = s.trialEndDate ?? s.nextBillingDate;
      if (compareDates(date, maxDate(range.from, today)) >= 0 && compareDates(date, range.to) <= 0) out.push({ date, kind: 'trial_end', ...base(s) });
    }
  }
  return out.sort((a, b) => compareDates(a.date, b.date) || a.name.localeCompare(b.name) || a.subscriptionId.localeCompare(b.subscriptionId));
}

/** Per-currency renewal counts and charges; currencies are never merged. */
export function renewalTotals(occurrences: readonly CalendarOccurrence[]): CalendarTotals[] {
  const byCurrency = new Map<CurrencyCode, CalendarTotals>();
  for (const o of occurrences) {
    if (o.kind !== 'renewal') continue;
    const cur = byCurrency.get(o.currency) ?? { currency: o.currency, renewalCount: 0, amountMinor: 0 };
    cur.renewalCount += 1;
    cur.amountMinor += o.amountMinor;
    byCurrency.set(o.currency, cur);
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export interface CalendarResponseMeta {
  /** The range actually evaluated (the requested `from` is raised to today). */
  from: DateOnly;
  to: DateOnly;
  today: DateOnly;
  timeZone: string;
  kind: 'projection';
  total: number;
  /** True when more than MAX_CALENDAR_OCCURRENCES existed; the earliest ones are returned. */
  truncated: boolean;
  totals: CalendarTotals[];
  trialEndCount: number;
}

