import {
  compareDates,
  isOccurrence,
  planAdvance,
  type CreatePaymentInput,
  type CurrencyCode,
  type DateOnly,
  type PaymentDto,
  type PaymentStatus,
  type PriceChangeDto,
  type RuleIssue,
  type SubscriptionDto,
} from '@subcycle/shared';
import { isUniqueViolation, withTransaction, type Pool, type Queryable } from '../db/pool.js';
import { conflict, notFound } from '../errors.js';
import { assertValidId, findOwned, toSubscriptionDto, validationError, type SubscriptionRow } from './subscriptions.js';

interface PaymentRow {
  id: string;
  subscription_id: string;
  amount_minor: number;
  currency: CurrencyCode;
  paid_on: DateOnly;
  status: PaymentStatus;
  for_billing_date: DateOnly | null;
  note: string | null;
  created_at: Date;
}

const toPaymentDto = (r: PaymentRow): PaymentDto => ({
  id: r.id,
  subscriptionId: r.subscription_id,
  amountMinor: r.amount_minor,
  currency: r.currency,
  paidOn: r.paid_on,
  status: r.status,
  forBillingDate: r.for_billing_date,
  note: r.note,
  source: 'user_entered',
  createdAt: r.created_at.toISOString(),
});

export interface Page {
  page: number;
  pageSize: number;
}

export interface PaymentResult {
  payment: PaymentDto;
  subscription: SubscriptionDto;
  /** True only when this call actually moved the stored next billing date. */
  nextBillingDateAdvanced: boolean;
}

/**
 * Records a payment the USER reports. Atomic: the subscription row is locked, the payment is inserted and
 * (optionally) the next billing date is advanced in ONE transaction, so a failure in either leaves neither.
 * Nothing here talks to a provider or bank; the row is stored exactly as entered.
 */
export async function createPayment(
  pool: Pool,
  userId: string,
  subscriptionId: string,
  input: CreatePaymentInput,
  today: DateOnly,
): Promise<PaymentResult> {
  return withTransaction(pool, async (tx) => {
    const sub = await findOwned(tx, userId, subscriptionId, true);
    const issues: RuleIssue[] = [];

    const paidOn = input.paidOn ?? today;
    if (compareDates(paidOn, today) > 0) {
      issues.push({ path: 'paidOn', message: 'A payment can’t be dated in the future. Record it once it has been made.' });
    }
    const status = input.status ?? 'paid';
    const forBillingDate = input.forBillingDate ?? null;
    let forDateOnSchedule = true;
    if (forBillingDate !== null && !isOccurrence(sub.anchor_date, sub.billing_frequency, forBillingDate)) {
      forDateOnSchedule = false;
      issues.push({ path: 'forBillingDate', message: 'This date is not on the subscription’s billing schedule.' });
    }

    let advanceTo: DateOnly | null = null;
    if (input.advanceNextBillingDate === true && forDateOnSchedule) {
      const plan = planAdvance({
        subscriptionStatus: sub.status,
        paymentStatus: status,
        anchorDate: sub.anchor_date,
        billingFrequency: sub.billing_frequency,
        storedNext: sub.next_billing_date,
        forBillingDate,
        today,
      });
      if (!plan.ok) issues.push({ path: plan.path, message: plan.message });
      else if (plan.changed) advanceTo = plan.nextBillingDate;
    }
    if (issues.length) throw validationError(issues);

    let payment: PaymentRow;
    try {
      const { rows } = await tx.query<PaymentRow>(
        `INSERT INTO payments (user_id, subscription_id, amount_minor, currency, paid_on, status, for_billing_date, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, subscription_id, amount_minor, currency, paid_on, status, for_billing_date, note, created_at`,
        [userId, subscriptionId, input.amountMinor, input.currency ?? sub.currency, paidOn, status, forBillingDate, input.note ?? null],
      );
      payment = rows[0]!;
    } catch (err) {
      // Enforced by the partial unique index (subscription_id, for_billing_date) WHERE status = 'paid'.
      if (isUniqueViolation(err)) {
        throw conflict('DUPLICATE_PAYMENT_PERIOD', `A paid payment is already recorded for the ${forBillingDate} renewal.`);
      }
      throw err;
    }

    let subRow: SubscriptionRow = sub;
    if (advanceTo !== null) {
      // The anchor is deliberately untouched: the new date is on the same schedule.
      const { rows } = await tx.query<SubscriptionRow>(
        'UPDATE subscriptions SET next_billing_date = $3 WHERE id = $1 AND user_id = $2 RETURNING *',
        [subscriptionId, userId, advanceTo],
      );
      subRow = rows[0]!;
    }
    return { payment: toPaymentDto(payment), subscription: toSubscriptionDto(subRow, today), nextBillingDateAdvanced: advanceTo !== null };
  });
}

export async function listPayments(
  db: Queryable,
  userId: string,
  subscriptionId: string,
  p: Page,
): Promise<{ items: PaymentDto[]; total: number }> {
  await findOwned(db, userId, subscriptionId);
  const count = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM payments WHERE subscription_id = $1 AND user_id = $2',
    [subscriptionId, userId],
  );
  const { rows } = await db.query<PaymentRow>(
    `SELECT id, subscription_id, amount_minor, currency, paid_on, status, for_billing_date, note, created_at
       FROM payments
      WHERE subscription_id = $1 AND user_id = $2
      ORDER BY paid_on DESC, created_at DESC, id DESC
      LIMIT $3 OFFSET $4`,
    [subscriptionId, userId, p.pageSize, (p.page - 1) * p.pageSize],
  );
  return { items: rows.map(toPaymentDto), total: count.rows[0]!.n };
}

/**
 * Removes a payment record (a correction of the user's own history). It does NOT move the subscription's
 * next billing date back: to change the schedule, edit the subscription.
 */
export async function deletePayment(pool: Pool, userId: string, subscriptionId: string, paymentId: string): Promise<void> {
  assertValidId(subscriptionId);
  await withTransaction(pool, async (tx) => {
    await findOwned(tx, userId, subscriptionId, true); // ownership of the parent first: identical 404 for foreign ids
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(paymentId)) throw notFound('Payment not found.');
    const result = await tx.query('DELETE FROM payments WHERE id = $1 AND subscription_id = $2 AND user_id = $3', [
      paymentId,
      subscriptionId,
      userId,
    ]);
    if (result.rowCount === 0) throw notFound('Payment not found.');
  });
}

// ───────────── price history ─────────────

interface PriceRow {
  id: string;
  subscription_id: string;
  old_amount_minor: number;
  new_amount_minor: number;
  currency: CurrencyCode;
  effective_on: DateOnly;
  note: string | null;
  created_at: Date;
}

/** Newest effective date first; ties by creation time, then id, so the order is fully deterministic. */
export async function listPriceHistory(
  db: Queryable,
  userId: string,
  subscriptionId: string,
  p: Page,
): Promise<{ items: PriceChangeDto[]; total: number }> {
  await findOwned(db, userId, subscriptionId);
  const count = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM subscription_price_history WHERE subscription_id = $1 AND user_id = $2',
    [subscriptionId, userId],
  );
  const { rows } = await db.query<PriceRow>(
    `SELECT id, subscription_id, old_amount_minor, new_amount_minor, currency, effective_on, note, created_at
       FROM subscription_price_history
      WHERE subscription_id = $1 AND user_id = $2
      ORDER BY effective_on DESC, created_at DESC, id DESC
      LIMIT $3 OFFSET $4`,
    [subscriptionId, userId, p.pageSize, (p.page - 1) * p.pageSize],
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      subscriptionId: r.subscription_id,
      oldAmountMinor: r.old_amount_minor,
      newAmountMinor: r.new_amount_minor,
      currency: r.currency,
      effectiveOn: r.effective_on,
      note: r.note,
      createdAt: r.created_at.toISOString(),
    })),
    total: count.rows[0]!.n,
  };
}
