import {
  addDays,
  compareDates,
  totalsMinor,
  type Category,
  type DateOnly,
  type PaymentDto,
  type SubscriptionDto,
} from '@subcycle/shared';
import { diffDays } from '@subcycle/shared';
import { orderCurrencies } from './money';

/**
 * Pure dashboard calculations. Three kinds of numbers are kept strictly apart (and labelled so in the UI):
 *  - ESTIMATE:   monthly equivalent / category split, from CURRENT prices of ACTIVE subscriptions
 *  - PROJECTION: annualized cost, upcoming renewal totals
 *  - RECORDED:   sums of payment records the user entered; nothing else ever feeds these
 * Currencies are never added together (there is no FX conversion).
 */

export interface CurrencyTotals {
  currency: string;
  monthlyEquivalentMinor: number;
  annualizedMinor: number;
  count: number;
}

const active = (subs: readonly SubscriptionDto[]) => subs.filter((s) => s.status === 'active');

export function activeTotals(subs: readonly SubscriptionDto[], preferred?: string): CurrencyTotals[] {
  const live = active(subs);
  return orderCurrencies(live.map((s) => s.currency), preferred).map((currency) => {
    const items = live.filter((s) => s.currency === currency);
    return { currency, count: items.length, ...totalsMinor(items) };
  });
}

export interface Renewal {
  subscription: SubscriptionDto;
  /** The actionable date: effectiveNextBillingDate (never the possibly stale stored date). */
  date: DateOnly;
  daysAway: number;
  kind: 'renewal' | 'trial_end';
  /** True when the stored date is behind and the date shown was calculated from the schedule. */
  calculated: boolean;
}

/**
 * Upcoming renewals in [today, today + windowDays]. Active subscriptions use their effective date;
 * trials appear as "trial ends" on their end date. Paused/cancelled/archived never appear.
 * One entry per subscription (a weekly subscription is not expanded into several rows).
 */
export function upcomingRenewals(subs: readonly SubscriptionDto[], today: DateOnly, windowDays: number): Renewal[] {
  const end = addDays(today, windowDays);
  const out: Renewal[] = [];
  for (const s of subs) {
    if (s.status !== 'active' && s.status !== 'trial') continue;
    const date = s.effectiveNextBillingDate;
    if (date === null || compareDates(date, today) < 0 || compareDates(date, end) > 0) continue;
    out.push({
      subscription: s,
      date,
      daysAway: diffDays(date, today),
      kind: s.status === 'trial' ? 'trial_end' : 'renewal',
      calculated: s.status === 'active' && s.nextBillingDate !== date,
    });
  }
  return out.sort((a, b) => compareDates(a.date, b.date) || a.subscription.name.localeCompare(b.subscription.name));
}

/** What will be charged by active renewals in the window, per currency. Trial endings carry no charge yet. */
export function renewalAmounts(renewals: readonly Renewal[], preferred?: string): { currency: string; amountMinor: number }[] {
  const charges = renewals.filter((r) => r.kind === 'renewal');
  return orderCurrencies(charges.map((r) => r.subscription.currency), preferred).map((currency) => ({
    currency,
    amountMinor: charges.filter((r) => r.subscription.currency === currency).reduce((n, r) => n + r.subscription.amountMinor, 0),
  }));
}

export interface CategoryShare {
  category: Category;
  monthlyEquivalentMinor: number;
  /** Share of the exact yearly total, 0-100. */
  percent: number;
}

export function categoryBreakdown(subs: readonly SubscriptionDto[], currency: string): CategoryShare[] {
  const items = active(subs).filter((s) => s.currency === currency);
  const grandYearly = totalsMinor(items).annualizedMinor;
  const byCategory = new Map<Category, SubscriptionDto[]>();
  for (const s of items) byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), s]);
  return [...byCategory.entries()]
    .map(([category, list]) => {
      const t = totalsMinor(list);
      return { category, monthlyEquivalentMinor: t.monthlyEquivalentMinor, percent: grandYearly === 0 ? 0 : (t.annualizedMinor / grandYearly) * 100, yearly: t.annualizedMinor };
    })
    .sort((a, b) => b.yearly - a.yearly || a.category.localeCompare(b.category))
    .map(({ yearly: _y, ...rest }) => rest);
}

export interface RecordedPayment {
  payment: PaymentDto;
  subscriptionId: string;
  subscriptionName: string;
}

export interface MonthTotal {
  month: string; // YYYY-MM
  netMinor: number;
}

/** The last `months` calendar months ending with today's month, oldest first. */
export function lastMonths(today: DateOnly, months: number): string[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return Array.from({ length: months }, (_, i) => {
    const total = y * 12 + (m - 1) - (months - 1 - i);
    return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
  });
}

/**
 * RECORDED spending per month in one currency: paid minus refunded, from payment records only.
 * Failed payments are ignored. Months with no records are 0; nothing is ever back-filled or estimated.
 */
export function recordedByMonth(payments: readonly RecordedPayment[], currency: string, today: DateOnly, months = 12): MonthTotal[] {
  const totals = new Map(lastMonths(today, months).map((m) => [m, 0]));
  for (const { payment } of payments) {
    if (payment.currency !== currency) continue;
    const month = payment.paidOn.slice(0, 7);
    if (!totals.has(month)) continue;
    if (payment.status === 'paid') totals.set(month, totals.get(month)! + payment.amountMinor);
    else if (payment.status === 'refunded') totals.set(month, totals.get(month)! - payment.amountMinor);
  }
  return [...totals.entries()].map(([month, netMinor]) => ({ month, netMinor }));
}

export function recordedCurrencies(payments: readonly RecordedPayment[], preferred?: string): string[] {
  return orderCurrencies(payments.map((p) => p.payment.currency), preferred);
}

export function recentPayments(payments: readonly RecordedPayment[], limit = 5): RecordedPayment[] {
  return [...payments]
    .sort((a, b) => compareDates(b.payment.paidOn, a.payment.paidOn) || b.payment.createdAt.localeCompare(a.payment.createdAt))
    .slice(0, limit);
}
