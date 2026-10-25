import {
  MAX_ANALYTICS_RANGE_DAYS,
  RECENT_PAYMENTS,
  addMonths,
  buildEstimate,
  buildProjection,
  bucketStart,
  diffDays,
  enumerateBuckets,
  type AnalyticsBucket,
  type AnalyticsResponse,
  type CurrencyCode,
  type DateOnly,
  type PaymentStatus,
  type RecentPayment,
  type RecordedBucket,
  type RecordedCurrency,
} from '@subcycle/shared';
import type { Queryable } from '../db/pool.js';
import { loadBillableSubs } from './calendar.js';
import { validationError } from './subscriptions.js';

interface BucketRow {
  currency: CurrencyCode;
  bucket: DateOnly;
  paid: number;
  refunded: number;
  n: number;
  failed: number;
}

// Two fixed statements instead of interpolating the bucket unit: no request value ever reaches SQL text.
const SELECT_BY_MONTH = `
  SELECT currency, date_trunc('month', paid_on)::date AS bucket,
         COALESCE(SUM(amount_minor) FILTER (WHERE status = 'paid'), 0)::bigint AS paid,
         COALESCE(SUM(amount_minor) FILTER (WHERE status = 'refunded'), 0)::bigint AS refunded,
         (COUNT(*) FILTER (WHERE status IN ('paid', 'refunded')))::int AS n,
         (COUNT(*) FILTER (WHERE status = 'failed'))::int AS failed
    FROM payments WHERE user_id = $1 AND paid_on BETWEEN $2::date AND $3::date
   GROUP BY currency, bucket`;
const SELECT_BY_WEEK = SELECT_BY_MONTH.replace("date_trunc('month'", "date_trunc('week'");

/**
 * Analytics for the signed-in user. Three kinds of numbers, kept apart in the response and never blended:
 *  - estimate:   active subscriptions' CURRENT prices normalised to a month/year (per currency)
 *  - recorded:   payment rows the user entered, paid minus refunded, bucketed by calendar month or ISO week of `paid_on`
 *  - projection: expected renewals in the next 7/30/90 days
 * A passed renewal date is never turned into a payment, and currencies are never summed together.
 * Date semantics: `from`/`to` are inclusive calendar dates; payment dates carry no time zone; "today" is the owner's
 * local date; `to` is clamped to today (no future buckets are invented). Weeks start on Monday.
 */
export async function getAnalytics(
  db: Queryable,
  userId: string,
  query: { from?: DateOnly; to?: DateOnly; bucket?: AnalyticsBucket },
  today: DateOnly,
  timeZone: string,
): Promise<AnalyticsResponse> {
  const bucket = query.bucket ?? 'month';
  const to = query.to && query.to < today ? query.to : today;
  const from = query.from ?? addMonths(bucketStart(today, 'month'), -11);
  if (from > to) throw validationError([{ path: 'from', message: '`from` must not be after `to` (and `to` is limited to today).' }]);
  if (diffDays(to, from) + 1 > MAX_ANALYTICS_RANGE_DAYS[bucket]) {
    throw validationError([{ path: 'from', message: `A ${bucket === 'month' ? 'monthly' : 'weekly'} breakdown can span at most ${MAX_ANALYTICS_RANGE_DAYS[bucket]} days.` }]);
  }

  const subs = await loadBillableSubs(db, userId);
  const { rows } = await db.query<BucketRow>(bucket === 'month' ? SELECT_BY_MONTH : SELECT_BY_WEEK, [userId, from, to]);

  const starts = enumerateBuckets(from, to, bucket);
  const currencies = [...new Set(rows.map((r) => r.currency))].sort();
  const recorded: RecordedCurrency[] = currencies.map((currency) => {
    const mine = rows.filter((r) => r.currency === currency);
    const buckets: RecordedBucket[] = starts.map((start) => {
      const r = mine.find((m) => m.bucket === start);
      const paid = r?.paid ?? 0;
      const refunded = r?.refunded ?? 0;
      return { start, paidMinor: paid, refundedMinor: refunded, netMinor: paid - refunded, paymentCount: r?.n ?? 0 };
    });
    const sum = (f: (b: RecordedBucket) => number) => buckets.reduce((n, b) => n + f(b), 0);
    return {
      currency, paidMinor: sum((b) => b.paidMinor), refundedMinor: sum((b) => b.refundedMinor), netMinor: sum((b) => b.netMinor),
      paymentCount: sum((b) => b.paymentCount), failedCount: mine.reduce((n, r) => n + r.failed, 0), buckets,
    };
  });

  const recent = await db.query<{ id: string; subscription_id: string; name: string; amount_minor: number; currency: CurrencyCode; paid_on: DateOnly; status: PaymentStatus; created_at: Date }>(
    `SELECT p.id, p.subscription_id, s.name, p.amount_minor, p.currency, p.paid_on, p.status, p.created_at
       FROM payments p JOIN subscriptions s ON s.id = p.subscription_id AND s.user_id = p.user_id
      WHERE p.user_id = $1 ORDER BY p.paid_on DESC, p.created_at DESC, p.id DESC LIMIT $2`,
    [userId, RECENT_PAYMENTS],
  );
  const recentPayments: RecentPayment[] = recent.rows.map((r) => ({
    paymentId: r.id, subscriptionId: r.subscription_id, subscriptionName: r.name, amountMinor: r.amount_minor, currency: r.currency,
    paidOn: r.paid_on, status: r.status, createdAt: r.created_at.toISOString(),
  }));

  return {
    timeZone,
    today,
    estimate: { kind: 'estimate', asOf: today, currencies: buildEstimate(subs) },
    recorded: { kind: 'recorded', from, to, bucket, currencies: recorded, recentPayments },
    projection: { kind: 'projection', windows: buildProjection(subs, today) },
  };
}
