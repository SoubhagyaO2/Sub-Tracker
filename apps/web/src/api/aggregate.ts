import type { DateOnly, SubscriptionDto } from '@subcycle/shared';
import type { RecordedPayment } from '../lib/dashboard';
import { monthStartBack } from '../lib/dates';
import { paymentsApi } from './endpoints';

/**
 * There is no cross-subscription payments endpoint yet (the analytics API arrives in Stage 7), so the dashboard
 * reads each subscription's payments through the documented per-subscription endpoint. To keep that bounded,
 * at most this many subscriptions (newest first) contribute; the UI says so when the cap applies.
 */
export const RECORDED_SUBSCRIPTION_CAP = 60;
const CONCURRENCY = 4;
const PAGE_SIZE = 100;

export interface RecordedPaymentsResult {
  payments: RecordedPayment[];
  /** True when some subscriptions were not included because of the cap. */
  partial: boolean;
}

/**
 * Every recorded payment from the last 12 months (plus the most recent page per subscription), read
 * newest-first and stopping per subscription once a page reaches back past the window.
 */
export async function fetchRecordedPayments(subs: readonly SubscriptionDto[], today: DateOnly, signal?: AbortSignal): Promise<RecordedPaymentsResult> {
  const targets = subs.slice(0, RECORDED_SUBSCRIPTION_CAP);
  const windowStart = monthStartBack(today, 11);
  const payments: RecordedPayment[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const sub = targets[cursor++];
      if (!sub) return;
      for (let page = 1; page <= 50; page++) {
        const { items, meta } = await paymentsApi.list(sub.id, { page, pageSize: PAGE_SIZE }, signal);
        for (const payment of items) payments.push({ payment, subscriptionId: sub.id, subscriptionName: sub.name });
        const last = items[items.length - 1];
        if (!last || page * PAGE_SIZE >= meta.total || last.paidOn < windowStart) break;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  return { payments, partial: subs.length > RECORDED_SUBSCRIPTION_CAP };
}
