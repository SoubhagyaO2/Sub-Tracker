import {
  addDays,
  compareDates,
  totalsMinor,
  type Category,
  type DateOnly,
  type SubscriptionDto,
} from '@subcycle/shared';
import { diffDays } from '@subcycle/shared';
import { orderCurrencies } from './money';

/**
 * Pure dashboard calculations. Estimates and projections (RECORDED spending is computed server-side, from payment rows only: GET /api/analytics/spending).
 * Three kinds of numbers are kept strictly apart (and labelled so in the UI):
 *  - ESTIMATE:   monthly equivalent / category split, from CURRENT prices of ACTIVE subscriptions
 *  - PROJECTION: annualized cost, upcoming renewal totals
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
