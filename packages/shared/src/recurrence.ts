import {
  addDays,
  compareDates,
  occurrence,
  parseDateOnly,
  isOccurrence,
  diffDays,
  type BillingFrequency,
  type DateOnly,
} from './dates.js';
import type { SubscriptionStatus } from './status.js';

/**
 * Recurrence engine. Everything is computed from the ANCHOR (never from a previous, possibly clamped,
 * result), so month-end schedules cannot drift, and everything is pure: callers pass "today".
 */

const MONTH_STEP = { monthly: 1, quarterly: 3, yearly: 12 } as const;
const MAX_ENUMERATION = 1000;

export const maxDate = (...dates: DateOnly[]): DateOnly => dates.reduce((a, b) => (compareDates(a, b) >= 0 ? a : b));

/** The first billing date of the series that is on or after `date` (the anchor itself if `date` precedes it). */
export function firstOccurrenceOnOrAfter(anchor: DateOnly, frequency: BillingFrequency, date: DateOnly): DateOnly {
  if (compareDates(date, anchor) <= 0) return anchor;

  if (frequency === 'weekly') {
    return occurrence(anchor, 'weekly', Math.ceil(diffDays(date, anchor) / 7));
  }

  const a = parseDateOnly(anchor)!;
  const t = parseDateOnly(date)!;
  const months = (t.y - a.y) * 12 + (t.m - a.m);
  let n = Math.max(0, Math.floor(months / MONTH_STEP[frequency]));
  // Month-end clamping can place occurrence n just before `date` within the same month; walk to the exact one.
  while (compareDates(occurrence(anchor, frequency, n), date) < 0) n++;
  while (n > 0 && compareDates(occurrence(anchor, frequency, n - 1), date) >= 0) n--;
  return occurrence(anchor, frequency, n);
}

/** The first billing date strictly after `date`. */
export const firstOccurrenceAfter = (anchor: DateOnly, frequency: BillingFrequency, date: DateOnly): DateOnly =>
  firstOccurrenceOnOrAfter(anchor, frequency, addDays(date, 1));

/**
 * Where a stale stored next-billing date should move to: the first occurrence on or after today.
 * Never moves backwards (a stored date already in the future is kept) and never leaves the anchor's series.
 */
export const rollForwardDate = (anchor: DateOnly, frequency: BillingFrequency, stored: DateOnly, today: DateOnly): DateOnly =>
  firstOccurrenceOnOrAfter(anchor, frequency, maxDate(stored, today));

/** Billing dates in [from, to] (inclusive), at most `limit`. Empty if the range is empty. */
export function occurrencesBetween(
  anchor: DateOnly,
  frequency: BillingFrequency,
  from: DateOnly,
  to: DateOnly,
  limit: number = MAX_ENUMERATION,
): DateOnly[] {
  const out: DateOnly[] = [];
  if (compareDates(from, to) > 0) return out;
  let d = firstOccurrenceOnOrAfter(anchor, frequency, from);
  while (compareDates(d, to) <= 0 && out.length < Math.min(limit, MAX_ENUMERATION)) {
    out.push(d);
    d = firstOccurrenceAfter(anchor, frequency, d);
  }
  return out;
}

/** The next `count` billing dates on or after `from`. */
export function nextOccurrences(anchor: DateOnly, frequency: BillingFrequency, from: DateOnly, count: number): DateOnly[] {
  const out: DateOnly[] = [];
  let d = firstOccurrenceOnOrAfter(anchor, frequency, from);
  while (out.length < Math.min(count, MAX_ENUMERATION)) {
    out.push(d);
    d = firstOccurrenceAfter(anchor, frequency, d);
  }
  return out;
}

/**
 * The upcoming billing date as of `today`, computed on read WITHOUT writing anything:
 * - active: the stored date rolled forward along the anchor's schedule
 * - trial: the stored date (a trial is never auto-converted; an ended trial keeps its past date)
 * - paused / cancelled / archived: null (they do not bill)
 */
export function effectiveNextBillingDate(
  s: { status: SubscriptionStatus; anchorDate: DateOnly; billingFrequency: BillingFrequency; nextBillingDate: DateOnly },
  today: DateOnly,
): DateOnly | null {
  if (s.status === 'active') return rollForwardDate(s.anchorDate, s.billingFrequency, s.nextBillingDate, today);
  if (s.status === 'trial') return s.nextBillingDate;
  return null;
}

// ───────────── recording a payment may advance the stored date ─────────────

export interface AdvanceInput {
  subscriptionStatus: SubscriptionStatus;
  paymentStatus: 'paid' | 'failed' | 'refunded';
  anchorDate: DateOnly;
  billingFrequency: BillingFrequency;
  storedNext: DateOnly;
  forBillingDate: DateOnly | null;
  today: DateOnly;
}
export type AdvancePlan =
  | { ok: true; nextBillingDate: DateOnly; changed: boolean }
  | { ok: false; path: string; message: string };

/**
 * Decides where `next_billing_date` goes when a payment for renewal R (= forBillingDate) is recorded with
 * "advance". The result stays on the anchor's schedule, never moves backwards, and is never in the past:
 *   new = first occurrence on/after max(stored, firstOccurrenceAfter(R), today)
 * R must be an occurrence no later than the upcoming renewal, so a renewal can't be skipped by paying ahead.
 */
export function planAdvance(i: AdvanceInput): AdvancePlan {
  const fail = (path: string, message: string): AdvancePlan => ({ ok: false, path, message });
  if (i.paymentStatus !== 'paid') return fail('advanceNextBillingDate', 'Only a paid payment can advance the next billing date.');
  if (i.subscriptionStatus !== 'active') {
    return fail('advanceNextBillingDate', 'The next billing date can only be advanced for an active subscription.');
  }
  if (i.forBillingDate === null) return fail('forBillingDate', 'forBillingDate is required to advance the next billing date.');
  if (!isOccurrence(i.anchorDate, i.billingFrequency, i.forBillingDate)) {
    return fail('forBillingDate', 'This date is not on the subscription’s billing schedule.');
  }
  const upcoming = rollForwardDate(i.anchorDate, i.billingFrequency, i.storedNext, i.today);
  if (compareDates(i.forBillingDate, upcoming) > 0) {
    return fail('forBillingDate', `Can’t advance past the next upcoming renewal (${upcoming}).`);
  }
  const after = firstOccurrenceAfter(i.anchorDate, i.billingFrequency, i.forBillingDate);
  const next = firstOccurrenceOnOrAfter(i.anchorDate, i.billingFrequency, maxDate(i.storedNext, after, i.today));
  return { ok: true, nextBillingDate: next, changed: next !== i.storedNext };
}
