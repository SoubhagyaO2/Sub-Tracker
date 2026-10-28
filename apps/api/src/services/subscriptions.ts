import {
  DEFAULT_PAGE_SIZE,
  MAX_SUBSCRIPTIONS_PER_USER,
  TransitionError,
  allowedActions,
  applyTransition,
  effectiveNextBillingDate,
  compareDates,
  monthlyEquivalentMinor,
  validateSubscriptionState,
  type BillingFrequency,
  type Category,
  type CreateSubscriptionInput,
  type CurrencyCode,
  type DateOnly,
  type ListSubscriptionsQuery,
  type RuleIssue,
  type SortKey,
  type SubscriptionDto,
  type SubscriptionStatus,
  type UpdateSubscriptionInput,
  type UsageLevel,
  statusActionSchema,
} from '@subcycle/shared';
import type { z } from 'zod';
import { withTransaction, type Pool, type Queryable } from '../db/pool.js';
import { AppError, conflict, notFound } from '../errors.js';

type StatusActionInput = z.infer<typeof statusActionSchema>;

// ───────────── row mapping ─────────────

export interface SubscriptionRow {
  id: string;
  user_id: string;
  name: string;
  category: Category;
  amount_minor: number;
  currency: CurrencyCode;
  billing_frequency: BillingFrequency;
  anchor_date: DateOnly;
  next_billing_date: DateOnly;
  start_date: DateOnly;
  trial_end_date: DateOnly | null;
  status: SubscriptionStatus;
  status_before_archive: Exclude<SubscriptionStatus, 'archived'> | null;
  cancelled_on: DateOnly | null;
  payment_method_label: string | null;
  website_url: string | null;
  cancellation_url: string | null;
  notes: string | null;
  usage_level: UsageLevel | null;
  reminder_lead_days: number | null;
  reminders_enabled: boolean;
  icon_kind: 'none' | 'glyph' | 'emoji';
  icon_value: string | null;
  /** Set only while the user has attached a picture (stored in subscription_icon_images). */
  icon_image_version: string | null;
  created_at: Date;
  updated_at: Date;
}

/** The picture a user attached wins over a logo or emoji; its value is the (same-origin) URL it is served from. */
export function iconDto(r: { id: string; icon_kind: 'none' | 'glyph' | 'emoji'; icon_value: string | null; icon_image_version: string | null }): SubscriptionDto['icon'] {
  if (r.icon_image_version) return { kind: 'image', value: `/api/subscriptions/${r.id}/icon-image?v=${r.icon_image_version}` };
  return r.icon_kind === 'none' || r.icon_value === null ? null : { kind: r.icon_kind, value: r.icon_value };
}

export function toSubscriptionDto(r: SubscriptionRow, today: DateOnly): SubscriptionDto {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    amountMinor: r.amount_minor,
    currency: r.currency,
    billingFrequency: r.billing_frequency,
    monthlyEquivalentMinor: monthlyEquivalentMinor(r.amount_minor, r.billing_frequency),
    anchorDate: r.anchor_date,
    nextBillingDate: r.next_billing_date,
    effectiveNextBillingDate: effectiveNextBillingDate(
      { status: r.status, anchorDate: r.anchor_date, billingFrequency: r.billing_frequency, nextBillingDate: r.next_billing_date },
      today,
    ),
    startDate: r.start_date,
    trialEndDate: r.trial_end_date,
    status: r.status,
    cancelledOn: r.cancelled_on,
    paymentMethodLabel: r.payment_method_label,
    websiteUrl: r.website_url,
    cancellationUrl: r.cancellation_url,
    notes: r.notes,
    usageLevel: r.usage_level,
    reminderLeadDays: r.reminder_lead_days,
    remindersEnabled: r.reminders_enabled,
    icon: iconDto(r),
    allowedActions: allowedActions(r.status),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id can never match a row; treat it exactly like "not found" (no existence signal). */
export function assertValidId(id: string): void {
  if (!UUID_RE.test(id)) throw notFound('Subscription not found.');
}

export const validationError = (issues: RuleIssue[]) =>
  new AppError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', issues);

// ───────────── reads ─────────────

/** Every read is scoped by user_id; the id alone never identifies a row. */
export async function findOwned(db: Queryable, userId: string, id: string, forUpdate = false): Promise<SubscriptionRow> {
  assertValidId(id);
  const { rows } = await db.query<SubscriptionRow>(
    forUpdate
      ? 'SELECT * FROM subscriptions WHERE id = $1 AND user_id = $2 FOR UPDATE'
      : 'SELECT * FROM subscriptions WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  const row = rows[0];
  if (!row) throw notFound('Subscription not found.');
  return row;
}

export async function getSubscription(db: Queryable, userId: string, id: string, today: DateOnly): Promise<SubscriptionDto> {
  return toSubscriptionDto(await findOwned(db, userId, id), today);
}

// Exact integer monthly-equivalent as a fraction NUM/DEN (see shared MONTHLY_FACTOR). Constants only.
const MONTHLY_NUM = "CASE billing_frequency WHEN 'weekly' THEN 52 ELSE 1 END";
const MONTHLY_DEN = "CASE billing_frequency WHEN 'weekly' THEN 12 WHEN 'quarterly' THEN 3 WHEN 'yearly' THEN 12 ELSE 1 END";

// ORDER BY fragments come ONLY from this allowlist; request input never reaches SQL text.
const SORT_SQL: Record<SortKey, string> = {
  name: 'lower(name)',
  nextRenewal: 'next_billing_date',
  price: `((amount_minor * (${MONTHLY_NUM}))::numeric / (${MONTHLY_DEN}))`,
  created: 'created_at',
};
const DEFAULT_ORDER: Record<SortKey, 'asc' | 'desc'> = { name: 'asc', nextRenewal: 'asc', price: 'desc', created: 'desc' };

export interface ListResult {
  items: SubscriptionDto[];
  page: number;
  pageSize: number;
  total: number;
}

export async function listSubscriptions(
  db: Queryable,
  userId: string,
  q: ListSubscriptionsQuery,
  today: DateOnly,
): Promise<ListResult> {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? DEFAULT_PAGE_SIZE;
  const sort = q.sort ?? 'created';
  const order = q.order ?? DEFAULT_ORDER[sort];

  const params: unknown[] = [userId];
  const where: string[] = ['user_id = $1'];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  // Archived subscriptions are hidden unless explicitly requested.
  if (q.status) where.push(`status = ANY(${bind(q.status)}::text[])`);
  else where.push("status <> 'archived'");
  if (q.category) where.push(`category = ANY(${bind(q.category)}::text[])`);
  if (q.frequency) where.push(`billing_frequency = ANY(${bind(q.frequency)}::text[])`);
  if (q.currency) where.push(`currency = ${bind(q.currency)}`);
  if (q.q) {
    const escaped = q.q.replace(/[\\%_]/g, (c) => `\\${c}`);
    where.push(`name ILIKE ${bind(`%${escaped}%`)} ESCAPE '\\'`);
  }
  if (q.minPrice !== undefined) where.push(`amount_minor * (${MONTHLY_NUM}) >= ${bind(q.minPrice)}::bigint * (${MONTHLY_DEN})`);
  if (q.maxPrice !== undefined) where.push(`amount_minor * (${MONTHLY_NUM}) <= ${bind(q.maxPrice)}::bigint * (${MONTHLY_DEN})`);
  if (q.renewsWithinDays !== undefined) {
    const t = bind(today);
    const n = bind(q.renewsWithinDays);
    where.push(`status IN ('active', 'trial') AND next_billing_date BETWEEN ${t}::date AND (${t}::date + ${n}::int)`);
  }
  const whereSql = where.join(' AND ');

  const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM subscriptions WHERE ${whereSql}`, params);
  const total = count.rows[0]!.n;

  const limit = bind(pageSize);
  const offset = bind((page - 1) * pageSize);
  const dir = order === 'asc' ? 'ASC' : 'DESC';
  const { rows } = await db.query<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE ${whereSql} ORDER BY ${SORT_SQL[sort]} ${dir}, id ${dir} LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { items: rows.map((r) => toSubscriptionDto(r, today)), page, pageSize, total };
}

// ───────────── create ─────────────

export interface WriteContext {
  today: DateOnly;
  defaultCurrency: CurrencyCode;
}

export async function createSubscription(
  pool: Pool,
  userId: string,
  input: CreateSubscriptionInput,
  ctx: WriteContext,
): Promise<SubscriptionDto> {
  const status = input.status ?? 'active';
  const trialEndDate = input.trialEndDate ?? null;
  // A trial's first charge is on the day the trial ends, unless the user says otherwise.
  const nextBillingDate = input.nextBillingDate ?? (status === 'trial' ? trialEndDate : null);
  const issues: RuleIssue[] = [];
  if (nextBillingDate === null) {
    issues.push({ path: 'nextBillingDate', message: 'Next billing date is required.' });
    throw validationError(issues);
  }
  const anchorDate = input.anchorDate ?? nextBillingDate;
  const startDate = input.startDate ?? (compareDates(anchorDate, ctx.today) < 0 ? anchorDate : ctx.today);

  issues.push(
    ...validateSubscriptionState(
      { status, billingFrequency: input.billingFrequency, anchorDate, nextBillingDate, startDate, trialEndDate },
      { today: ctx.today, checkNotPast: true },
    ),
  );
  if (issues.length) throw validationError(issues);

  return withTransaction(pool, async (tx) => {
    // Serialize creates per user so the per-user cap cannot be raced past.
    await tx.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const count = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM subscriptions WHERE user_id = $1', [userId]);
    if (count.rows[0]!.n >= MAX_SUBSCRIPTIONS_PER_USER) {
      throw conflict('SUBSCRIPTION_LIMIT_REACHED', `You can track up to ${MAX_SUBSCRIPTIONS_PER_USER} subscriptions.`);
    }
    // No payment rows are created here or anywhere in subscription writes.
    const { rows } = await tx.query<SubscriptionRow>(
      `INSERT INTO subscriptions
         (user_id, name, category, amount_minor, currency, billing_frequency, anchor_date, next_billing_date,
          start_date, trial_end_date, status, payment_method_label, website_url, cancellation_url, notes,
          usage_level, reminder_lead_days, reminders_enabled, icon_kind, icon_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [
        userId,
        input.name,
        input.category ?? 'other',
        input.amountMinor,
        input.currency ?? ctx.defaultCurrency,
        input.billingFrequency,
        anchorDate,
        nextBillingDate,
        startDate,
        trialEndDate,
        status,
        input.paymentMethodLabel ?? null,
        input.websiteUrl ?? null,
        input.cancellationUrl ?? null,
        input.notes ?? null,
        input.usageLevel ?? null,
        input.reminderLeadDays ?? null,
        input.remindersEnabled ?? true,
        input.icon?.kind ?? 'none',
        input.icon?.value ?? null,
      ],
    );
    return toSubscriptionDto(rows[0]!, ctx.today);
  });
}

// ───────────── update ─────────────

export async function updateSubscription(
  pool: Pool,
  userId: string,
  id: string,
  patch: UpdateSubscriptionInput,
  ctx: WriteContext,
): Promise<SubscriptionDto> {
  return withTransaction(pool, async (tx) => {
    const cur = await findOwned(tx, userId, id, true);
    const issues: RuleIssue[] = [];
    const pick = <T>(next: T | undefined, current: T): T => (next === undefined ? current : next);

    const billingFrequency = pick(patch.billingFrequency, cur.billing_frequency);
    const frequencyChanged = billingFrequency !== cur.billing_frequency;
    if (frequencyChanged && patch.nextBillingDate === undefined) {
      issues.push({ path: 'nextBillingDate', message: 'Provide the next billing date when changing the billing frequency.' });
    }

    // Declaring a next billing date declares a new schedule: it becomes the anchor unless one is given.
    const nextBillingDate = pick(patch.nextBillingDate, cur.next_billing_date);
    const anchorDate =
      patch.nextBillingDate !== undefined ? (patch.anchorDate ?? patch.nextBillingDate) : pick(patch.anchorDate, cur.anchor_date);
    const startDate = pick(patch.startDate, cur.start_date);
    const trialEndDate = pick(patch.trialEndDate, cur.trial_end_date);

    issues.push(
      ...validateSubscriptionState(
        { status: cur.status, billingFrequency, anchorDate, nextBillingDate, startDate, trialEndDate },
        { today: ctx.today, checkNotPast: patch.nextBillingDate !== undefined },
      ).filter((i) => !(frequencyChanged && patch.nextBillingDate === undefined && i.path === 'nextBillingDate')),
    );

    const amountMinor = pick(patch.amountMinor, cur.amount_minor);
    const currency = pick(patch.currency, cur.currency);
    const amountChanged = amountMinor !== cur.amount_minor;
    const currencyChanged = currency !== cur.currency;
    const recordsHistory = amountChanged && !currencyChanged && patch.recordPriceChange !== false;

    const priceFieldsGiven = (
      [['recordPriceChange', patch.recordPriceChange], ['priceChangeEffectiveOn', patch.priceChangeEffectiveOn], ['priceChangeNote', patch.priceChangeNote]] as const
    ).filter(([, v]) => v !== undefined);
    if (priceFieldsGiven.length && !(amountChanged && !currencyChanged)) {
      issues.push({ path: priceFieldsGiven[0]![0], message: 'Only applies when the amount changes (and the currency does not).' });
    }
    const effectiveOn = patch.priceChangeEffectiveOn ?? ctx.today;
    if (compareDates(effectiveOn, ctx.today) > 0) {
      issues.push({ path: 'priceChangeEffectiveOn', message: 'The effective date can’t be in the future.' });
    }
    if (issues.length) throw validationError(issues);

    if (currencyChanged) {
      // History and payments are denominated in the original currency; changing it would make them ambiguous.
      const locked = await tx.query<{ locked: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM subscription_price_history WHERE subscription_id = $1 AND user_id = $2)
             OR EXISTS (SELECT 1 FROM payments WHERE subscription_id = $1 AND user_id = $2) AS locked`,
        [id, userId],
      );
      if (locked.rows[0]!.locked) {
        throw conflict('CURRENCY_LOCKED', 'The currency can’t be changed once payments or price changes are recorded. Archive this subscription and add a new one instead.');
      }
    }

    if (recordsHistory) {
      await tx.query(
        `INSERT INTO subscription_price_history
           (user_id, subscription_id, old_amount_minor, new_amount_minor, currency, effective_on, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, id, cur.amount_minor, amountMinor, currency, effectiveOn, patch.priceChangeNote ?? null],
      );
    }

    const icon = patch.icon === undefined ? { kind: cur.icon_kind, value: cur.icon_value } : patch.icon === null ? { kind: 'none' as const, value: null } : patch.icon;
    const { rows } = await tx.query<SubscriptionRow>(
      `UPDATE subscriptions SET
         name = $3, category = $4, amount_minor = $5, currency = $6, billing_frequency = $7,
         anchor_date = $8, next_billing_date = $9, start_date = $10, trial_end_date = $11,
         payment_method_label = $12, website_url = $13, cancellation_url = $14, notes = $15,
         usage_level = $16, reminder_lead_days = $17, reminders_enabled = $18, icon_kind = $19, icon_value = $20
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        id,
        userId,
        pick(patch.name, cur.name),
        pick(patch.category, cur.category),
        amountMinor,
        currency,
        billingFrequency,
        anchorDate,
        nextBillingDate,
        startDate,
        trialEndDate,
        pick(patch.paymentMethodLabel, cur.payment_method_label),
        pick(patch.websiteUrl, cur.website_url),
        pick(patch.cancellationUrl, cur.cancellation_url),
        pick(patch.notes, cur.notes),
        pick(patch.usageLevel, cur.usage_level),
        pick(patch.reminderLeadDays, cur.reminder_lead_days),
        pick(patch.remindersEnabled, cur.reminders_enabled),
        icon.kind,
        icon.value,
      ],
    );
    const updated = rows[0]!;
    if (patch.icon !== undefined && updated.icon_image_version) {
      // Choosing a logo, an emoji or "no icon" replaces a picture the user had attached.
      await tx.query('DELETE FROM subscription_icon_images WHERE subscription_id = $1 AND user_id = $2', [id, userId]);
      await tx.query('UPDATE subscriptions SET icon_image_version = NULL WHERE id = $1 AND user_id = $2', [id, userId]);
      updated.icon_image_version = null;
    }
    return toSubscriptionDto(updated, ctx.today);
  });
}

// ───────────── status transitions ─────────────

export async function transitionSubscription(
  pool: Pool,
  userId: string,
  id: string,
  input: StatusActionInput,
  today: DateOnly,
): Promise<SubscriptionDto> {
  return withTransaction(pool, async (tx) => {
    const cur = await findOwned(tx, userId, id, true);
    let result;
    try {
      result = applyTransition(
        {
          status: cur.status,
          statusBeforeArchive: cur.status_before_archive,
          anchorDate: cur.anchor_date,
          nextBillingDate: cur.next_billing_date,
          startDate: cur.start_date,
          cancelledOn: cur.cancelled_on,
        },
        input,
        today,
      );
    } catch (err) {
      if (err instanceof TransitionError) {
        if (err.kind === 'invalid_transition') throw conflict('INVALID_TRANSITION', err.message);
        throw validationError([{ path: err.path ?? 'action', message: err.message }]);
      }
      throw err;
    }
    const { rows } = await tx.query<SubscriptionRow>(
      `UPDATE subscriptions SET
         status = $3, status_before_archive = $4, cancelled_on = $5, anchor_date = $6, next_billing_date = $7
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId, result.status, result.statusBeforeArchive, result.cancelledOn, result.anchorDate, result.nextBillingDate],
    );
    return toSubscriptionDto(rows[0]!, today);
  });
}

// ───────────── delete ─────────────

/** Permanent removal; payments, price history and reminders cascade at the database level. */
export async function deleteSubscription(db: Queryable, userId: string, id: string): Promise<void> {
  assertValidId(id);
  const result = await db.query('DELETE FROM subscriptions WHERE id = $1 AND user_id = $2', [id, userId]);
  if (result.rowCount === 0) throw notFound('Subscription not found.');
}
