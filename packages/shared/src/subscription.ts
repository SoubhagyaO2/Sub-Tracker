import { z } from 'zod';
import { CURRENCY_CODES, isSupportedCurrency, type CurrencyCode } from './currency.js';
import {
  compareDates,
  isOccurrence,
  isValidDateOnly,
  parseDateOnly,
  type BillingFrequency,
  type DateOnly,
} from './dates.js';
import { MAX_AMOUNT_MINOR } from './money.js';
import { CARD_DATA_MESSAGE, looksLikeCardData } from './pan.js';
import { CREATABLE_STATUSES, STATUS_ACTIONS, type SubscriptionStatus } from './status.js';

export const CATEGORIES = [
  'entertainment', 'music', 'video', 'gaming', 'productivity', 'cloud_storage', 'ai_tools',
  'news_reading', 'fitness_health', 'education', 'shopping', 'utilities', 'finance', 'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
export const USAGE_LEVELS = ['often', 'sometimes', 'rarely'] as const;
export type UsageLevel = (typeof USAGE_LEVELS)[number];

export const MAX_SUBSCRIPTIONS_PER_USER = 500;
export const MIN_YEAR = 1990;
export const MAX_YEAR = 2100;

// ───────────── field building blocks ─────────────

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const noControlChars = (s: string, allowNewlines: boolean) =>
  !/\p{Cc}/u.test(allowNewlines ? s.replace(/[\n\r\t]/g, '') : s);

/** Optional, clearable text: '' and null both mean "none". */
function nullableText(max: number, opts: { multiline?: boolean; noCardData?: boolean } = {}) {
  let inner = z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters.`)
    .refine((s) => noControlChars(s, opts.multiline ?? false), 'Contains unsupported control characters.');
  if (opts.noCardData) inner = inner.refine((s) => !looksLikeCardData(s), CARD_DATA_MESSAGE);
  return z.preprocess(emptyToNull, inner.nullable()).optional();
}

const dateOnly = z
  .string()
  .refine(isValidDateOnly, 'Use a valid calendar date in YYYY-MM-DD format.')
  .refine((s) => {
    const p = parseDateOnly(s);
    return p !== null && p.y >= MIN_YEAR && p.y <= MAX_YEAR;
  }, `Year must be between ${MIN_YEAR} and ${MAX_YEAR}.`);

const currency = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isSupportedCurrency, `Unsupported currency. Supported: ${CURRENCY_CODES.join(', ')}.`);

function isHttpUrl(s: string): boolean {
  if (!/^https?:\/\//i.test(s) || /\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname !== '' && !u.username && !u.password;
  } catch {
    return false;
  }
}
const httpUrl = z.preprocess(
  emptyToNull,
  z.string().trim().max(2048, 'Must be at most 2048 characters.').refine(isHttpUrl, 'Enter a valid http(s) URL without credentials.').nullable(),
).optional();

const iconSchema = z
  .strictObject({ kind: z.enum(['glyph', 'emoji']), value: z.string().trim() })
  .superRefine((icon, ctx) => {
    const ok =
      icon.kind === 'glyph'
        ? /^[a-z0-9-]{1,32}$/.test(icon.value)
        : icon.value.length > 0 && icon.value.length <= 32 && /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️)+$/u.test(icon.value);
    if (!ok) ctx.addIssue({ code: 'custom', path: ['value'], message: icon.kind === 'glyph' ? 'Use a lowercase glyph key.' : 'Use a single emoji.' });
  });

const fields = {
  name: z.string().trim().min(1, 'Name is required.').max(80, 'Must be at most 80 characters.').refine((s) => noControlChars(s, false), 'Contains unsupported control characters.'),
  category: z.enum(CATEGORIES),
  amountMinor: z.number().int('Amount must be a whole number of minor units.').min(1, 'Amount must be greater than zero.').max(MAX_AMOUNT_MINOR, 'Amount is too large.'),
  currency,
  billingFrequency: z.enum(FREQUENCIES),
  nextBillingDate: dateOnly,
  anchorDate: dateOnly,
  startDate: dateOnly,
  trialEndDate: dateOnly.nullable(),
  paymentMethodLabel: nullableText(40, { noCardData: true }),
  websiteUrl: httpUrl,
  cancellationUrl: httpUrl,
  notes: nullableText(2000, { multiline: true, noCardData: true }),
  usageLevel: z.enum(USAGE_LEVELS).nullable(),
  reminderLeadDays: z.number().int().min(0).max(60).nullable(),
  remindersEnabled: z.boolean(),
  icon: iconSchema.nullable(),
};

// ───────────── request schemas ─────────────

/** Unknown keys are rejected. user_id, id and timestamps can never be supplied by the client. */
export const createSubscriptionSchema = z.strictObject({
  name: fields.name,
  amountMinor: fields.amountMinor,
  billingFrequency: fields.billingFrequency,
  category: fields.category.optional(),
  currency: fields.currency.optional(),
  status: z.enum(CREATABLE_STATUSES).optional(),
  nextBillingDate: fields.nextBillingDate.optional(),
  anchorDate: fields.anchorDate.optional(),
  startDate: fields.startDate.optional(),
  trialEndDate: fields.trialEndDate.optional(),
  paymentMethodLabel: fields.paymentMethodLabel,
  websiteUrl: fields.websiteUrl,
  cancellationUrl: fields.cancellationUrl,
  notes: fields.notes,
  usageLevel: fields.usageLevel.optional(),
  reminderLeadDays: fields.reminderLeadDays.optional(),
  remindersEnabled: fields.remindersEnabled.optional(),
  icon: fields.icon.optional(),
});
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;

/** `status` is intentionally absent: status changes go through POST /subscriptions/:id/status. */
export const updateSubscriptionSchema = z
  .strictObject({
    name: fields.name.optional(),
    amountMinor: fields.amountMinor.optional(),
    billingFrequency: fields.billingFrequency.optional(),
    category: fields.category.optional(),
    currency: fields.currency.optional(),
    nextBillingDate: fields.nextBillingDate.optional(),
    anchorDate: fields.anchorDate.optional(),
    startDate: fields.startDate.optional(),
    trialEndDate: fields.trialEndDate.optional(),
    paymentMethodLabel: fields.paymentMethodLabel,
    websiteUrl: fields.websiteUrl,
    cancellationUrl: fields.cancellationUrl,
    notes: fields.notes,
    usageLevel: fields.usageLevel.optional(),
    reminderLeadDays: fields.reminderLeadDays.optional(),
    remindersEnabled: fields.remindersEnabled.optional(),
    icon: fields.icon.optional(),
    // Only meaningful when amountMinor actually changes.
    recordPriceChange: z.boolean().optional(),
    priceChangeEffectiveOn: dateOnly.optional(),
    priceChangeNote: nullableText(500),
  })
  .refine((o) => Object.values(o).some((v) => v !== undefined), { message: 'Provide at least one field to update.' });
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;

export const statusActionSchema = z.strictObject({
  action: z.enum(STATUS_ACTIONS),
  nextBillingDate: dateOnly.optional(),
  cancelledOn: dateOnly.optional(),
});
export type StatusActionInput = z.infer<typeof statusActionSchema>;

// ───────────── list query ─────────────

export const SORT_KEYS = ['name', 'nextRenewal', 'price', 'created'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const toList = (v: unknown): unknown =>
  typeof v === 'string'
    ? v.split(',').map((s) => s.trim()).filter(Boolean)
    : Array.isArray(v)
      ? v.flatMap((x) => (typeof x === 'string' ? x.split(',').map((s) => s.trim()).filter(Boolean) : [x]))
      : v;
const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(toList, z.array(z.enum(values)).min(1, 'Provide at least one value.').max(values.length)).optional();

export const intParam = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,13}$/, 'Must be a non-negative integer.')
    .transform(Number)
    .pipe(z.number().int().min(min, `Must be at least ${min}.`).max(max, `Must be at most ${max}.`))
    .optional();

export const listSubscriptionsQuerySchema = z
  .strictObject({
    page: intParam(1, 100_000),
    pageSize: intParam(1, MAX_PAGE_SIZE),
    q: z.string().trim().min(1).max(80).refine((s) => noControlChars(s, false), 'Contains unsupported control characters.').optional(),
    status: csvEnum([...['active', 'trial', 'paused', 'cancelled', 'archived']] as ['active', 'trial', 'paused', 'cancelled', 'archived']),
    category: csvEnum(CATEGORIES),
    frequency: csvEnum(FREQUENCIES),
    currency: currency.optional(),
    /** Price range applies to the MONTHLY-EQUIVALENT in minor units and requires `currency`. */
    minPrice: intParam(0, MAX_AMOUNT_MINOR),
    maxPrice: intParam(0, MAX_AMOUNT_MINOR),
    /** Active/trial subscriptions whose next billing date falls within N days from today (inclusive). */
    renewsWithinDays: intParam(1, 366),
    sort: z.enum(SORT_KEYS).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  })
  .superRefine((q, ctx) => {
    if ((q.minPrice !== undefined || q.maxPrice !== undefined) && q.currency === undefined) {
      ctx.addIssue({ code: 'custom', path: ['currency'], message: 'currency is required when filtering by price.' });
    }
    if (q.minPrice !== undefined && q.maxPrice !== undefined && q.minPrice > q.maxPrice) {
      ctx.addIssue({ code: 'custom', path: ['minPrice'], message: 'minPrice must not exceed maxPrice.' });
    }
  });
export type ListSubscriptionsQuery = z.infer<typeof listSubscriptionsQuerySchema>;

// ───────────── cross-field rules (shared by create, update and the UI) ─────────────

export interface SubscriptionRuleState {
  status: SubscriptionStatus;
  billingFrequency: BillingFrequency;
  anchorDate: DateOnly;
  nextBillingDate: DateOnly;
  startDate: DateOnly;
  trialEndDate: DateOnly | null;
}
export interface RuleIssue {
  path: string;
  message: string;
}

/**
 * Invariants of a subscription's dates. `nextBillingDate` must lie on the schedule generated from
 * `anchorDate` + frequency; this is what prevents month-end drift from ever being persisted.
 * `checkNotPast` is applied only when the caller is (re)setting the next billing date, so editing
 * unrelated fields of an old record never fails because time has passed.
 */
export function validateSubscriptionState(s: SubscriptionRuleState, opts: { today: DateOnly; checkNotPast: boolean }): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (compareDates(s.nextBillingDate, s.startDate) < 0) {
    issues.push({ path: 'nextBillingDate', message: 'Next billing date can’t be before the start date.' });
  }
  if (!isOccurrence(s.anchorDate, s.billingFrequency, s.nextBillingDate)) {
    issues.push({
      path: 'nextBillingDate',
      message: 'Next billing date must fall on the billing schedule set by the anchor date and frequency.',
    });
  }
  if (s.status === 'trial' && s.trialEndDate === null) {
    issues.push({ path: 'trialEndDate', message: 'Trial end date is required for a trial.' });
  }
  if (s.trialEndDate !== null && compareDates(s.trialEndDate, s.startDate) < 0) {
    issues.push({ path: 'trialEndDate', message: 'Trial end date can’t be before the start date.' });
  }
  if (opts.checkNotPast && (s.status === 'active' || s.status === 'trial') && compareDates(s.nextBillingDate, opts.today) < 0) {
    issues.push({ path: 'nextBillingDate', message: 'Next billing date can’t be in the past.' });
  }
  return issues;
}

// ───────────── response shape ─────────────

export interface SubscriptionDto {
  id: string;
  name: string;
  category: Category;
  amountMinor: number;
  currency: CurrencyCode;
  billingFrequency: BillingFrequency;
  /** Estimate: per-row monthly equivalent, rounded half-up. Not a recorded amount. */
  monthlyEquivalentMinor: number;
  anchorDate: DateOnly;
  nextBillingDate: DateOnly;
  startDate: DateOnly;
  trialEndDate: DateOnly | null;
  status: SubscriptionStatus;
  cancelledOn: DateOnly | null;
  paymentMethodLabel: string | null;
  websiteUrl: string | null;
  cancellationUrl: string | null;
  notes: string | null;
  usageLevel: UsageLevel | null;
  reminderLeadDays: number | null;
  remindersEnabled: boolean;
  icon: { kind: 'glyph' | 'emoji'; value: string } | null;
  /**
   * The upcoming billing date as of today, COMPUTED ON READ (nothing is written): active subscriptions roll the
   * stored date forward along the anchor's schedule; trials keep their stored date; others are null.
   * `nextBillingDate` is the stored value, which a background job (not a read) advances.
   */
  effectiveNextBillingDate: DateOnly | null;
  /** Actions the state machine currently permits, so clients never guess. */
  allowedActions: string[];
  createdAt: string;
  updatedAt: string;
}
