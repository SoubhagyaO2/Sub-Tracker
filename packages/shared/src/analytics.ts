import { z } from 'zod';
import { addDays, addMonths, compareDates, diffDays, formatDateOnly, isValidDateOnly, parseDateOnly, type DateOnly } from './dates.js';
import { collectOccurrences, renewalTotals, type CalendarOccurrence, type CalendarSub } from './calendar.js';
import type { CurrencyCode } from './currency.js';
import { totalsMinor } from './money.js';
import { MAX_YEAR, MIN_YEAR, type Category } from './subscription.js';
import type { BillingFrequency } from './dates.js';
import type { PaymentStatus } from './payment.js';

export const ANALYTICS_BUCKETS = ['month', 'week'] as const;
export type AnalyticsBucket = (typeof ANALYTICS_BUCKETS)[number];
/** Longest selectable period per bucket size, in days (about 5 years of months, or one year of weeks). */
export const MAX_ANALYTICS_RANGE_DAYS: Record<AnalyticsBucket, number> = { month: 1830, week: 372 };
export const PROJECTION_WINDOWS = [7, 30, 90] as const;
export const TOP_SUBSCRIPTIONS = 5;
export const RECENT_PAYMENTS = 5;

const dateOnly = z
  .string()
  .refine(isValidDateOnly, 'Use a valid calendar date in YYYY-MM-DD format.')
  .refine((s) => {
    const p = parseDateOnly(s);
    return p !== null && p.y >= MIN_YEAR && p.y <= MAX_YEAR;
  }, `Year must be between ${MIN_YEAR} and ${MAX_YEAR}.`);

/** `from`/`to` are inclusive calendar dates (payment dates carry no time zone). Defaults are resolved server-side. */
export const analyticsQuerySchema = z
  .strictObject({ from: dateOnly.optional(), to: dateOnly.optional(), bucket: z.enum(ANALYTICS_BUCKETS).optional() })
  .superRefine((q, ctx) => {
    if (q.from && q.to && compareDates(q.to, q.from) < 0) ctx.addIssue({ code: 'custom', path: ['to'], message: '`to` must not be before `from`.' });
  });

// ───────────── buckets ─────────────

/** Start of the bucket containing `date`: the 1st of its month, or the Monday (ISO week) on or before it. */
export function bucketStart(date: DateOnly, bucket: AnalyticsBucket): DateOnly {
  const p = parseDateOnly(date)!;
  if (bucket === 'month') return formatDateOnly(p.y, p.m, 1);
  const dayIndex = (diffDays(date, '1970-01-01') + 3) % 7; // 1970-01-01 was a Thursday; Monday = 0
  return addDays(date, -((dayIndex + 7) % 7));
}

/** Every bucket start from the one containing `from` up to the one containing `to`, in order. Zero-activity buckets included. */
export function enumerateBuckets(from: DateOnly, to: DateOnly, bucket: AnalyticsBucket): DateOnly[] {
  const out: DateOnly[] = [];
  let cur = bucketStart(from, bucket);
  while (compareDates(cur, to) <= 0) {
    out.push(cur);
    cur = bucket === 'month' ? addMonths(cur, 1) : addDays(cur, 7);
  }
  return out;
}

// ───────────── response types ─────────────

export interface EstimateCategory {
  category: Category;
  subscriptionCount: number;
  monthlyEquivalentMinor: number;
  annualizedMinor: number;
  /** Share of the exact yearly total in this currency, 0 to 100. */
  percent: number;
}
export interface EstimateTop {
  subscriptionId: string;
  name: string;
  category: Category;
  billingFrequency: BillingFrequency;
  amountMinor: number;
  monthlyEquivalentMinor: number;
}
export interface EstimateCurrency {
  currency: CurrencyCode;
  subscriptionCount: number;
  monthlyEquivalentMinor: number;
  annualizedMinor: number;
  byCategory: EstimateCategory[];
  top: EstimateTop[];
}

export interface RecordedBucket {
  /** First day of the month, or the Monday of the ISO week. The first/last bucket may extend past the requested range; only payments inside it count. */
  start: DateOnly;
  paidMinor: number;
  refundedMinor: number;
  netMinor: number;
  paymentCount: number;
}
export interface RecordedCurrency {
  currency: CurrencyCode;
  paidMinor: number;
  refundedMinor: number;
  netMinor: number;
  paymentCount: number;
  failedCount: number;
  buckets: RecordedBucket[];
}
export interface RecentPayment {
  paymentId: string;
  subscriptionId: string;
  subscriptionName: string;
  amountMinor: number;
  currency: CurrencyCode;
  paidOn: DateOnly;
  status: PaymentStatus;
  createdAt: string;
}

export interface ProjectionWindow {
  days: number;
  to: DateOnly;
  currencies: { currency: CurrencyCode; renewalCount: number; amountMinor: number }[];
  trialEndCount: number;
}

export interface AnalyticsResponse {
  timeZone: string;
  today: DateOnly;
  /** ESTIMATE: normalised recurring cost of ACTIVE subscriptions at their CURRENT prices. Not money paid. */
  estimate: { kind: 'estimate'; asOf: DateOnly; currencies: EstimateCurrency[] };
  /** RECORDED: only payments the user entered (paid minus refunded). Not verified against any bank or provider. */
  recorded: {
    kind: 'recorded';
    from: DateOnly;
    to: DateOnly;
    bucket: AnalyticsBucket;
    currencies: RecordedCurrency[];
    recentPayments: RecentPayment[];
  };
  /** PROJECTION: expected future renewals at current prices. Not confirmed charges. */
  projection: { kind: 'projection'; windows: ProjectionWindow[] };
}

// ───────────── pure builders ─────────────

export interface AnalyticsSub extends CalendarSub {
  currency: CurrencyCode;
}

/** Per-currency estimate from ACTIVE subscriptions. Trial, paused, cancelled and archived are excluded. */
export function buildEstimate(subs: readonly AnalyticsSub[]): EstimateCurrency[] {
  const active = subs.filter((s) => s.status === 'active');
  const currencies = [...new Set(active.map((s) => s.currency))].sort();
  return currencies.map((currency) => {
    const items = active.filter((s) => s.currency === currency);
    const total = totalsMinor(items);
    const byCat = new Map<Category, AnalyticsSub[]>();
    for (const s of items) byCat.set(s.category, [...(byCat.get(s.category) ?? []), s]);
    const byCategory = [...byCat.entries()]
      .map(([category, list]) => {
        const t = totalsMinor(list);
        return {
          category,
          subscriptionCount: list.length,
          monthlyEquivalentMinor: t.monthlyEquivalentMinor,
          annualizedMinor: t.annualizedMinor,
          percent: total.annualizedMinor === 0 ? 0 : (t.annualizedMinor / total.annualizedMinor) * 100,
        };
      })
      .sort((a, b) => b.annualizedMinor - a.annualizedMinor || a.category.localeCompare(b.category));
    const top = [...items]
      .map((s) => ({ s, yearly: totalsMinor([s]).annualizedMinor }))
      .sort((a, b) => b.yearly - a.yearly || a.s.name.localeCompare(b.s.name) || a.s.id.localeCompare(b.s.id))
      .slice(0, TOP_SUBSCRIPTIONS)
      .map(({ s }) => ({
        subscriptionId: s.id, name: s.name, category: s.category, billingFrequency: s.billingFrequency,
        amountMinor: s.amountMinor, monthlyEquivalentMinor: totalsMinor([s]).monthlyEquivalentMinor,
      }));
    return { currency, subscriptionCount: items.length, ...total, byCategory, top };
  });
}

/** Expected renewals in the next 7/30/90 days, per currency, from the same occurrence rules as the calendar. */
export function buildProjection(subs: readonly CalendarSub[], today: DateOnly): ProjectionWindow[] {
  return PROJECTION_WINDOWS.map((days) => {
    const to = addDays(today, days);
    const occurrences: CalendarOccurrence[] = collectOccurrences(subs, { from: today, to }, today);
    return {
      days,
      to,
      currencies: renewalTotals(occurrences).map(({ currency, renewalCount, amountMinor }) => ({ currency, renewalCount, amountMinor })),
      trialEndCount: occurrences.filter((o) => o.kind === 'trial_end').length,
    };
  });
}
