import { z } from 'zod';
import { CURRENCY_CODES, isSupportedCurrency, type CurrencyCode } from './currency.js';
import { isValidDateOnly, parseDateOnly, type DateOnly } from './dates.js';
import { MAX_AMOUNT_MINOR } from './money.js';
import { CARD_DATA_MESSAGE, looksLikeCardData } from './pan.js';
import { MAX_PAGE_SIZE, MAX_YEAR, MIN_YEAR, intParam } from './subscription.js';

export const PAYMENT_STATUSES = ['paid', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const dateOnly = z
  .string()
  .refine(isValidDateOnly, 'Use a valid calendar date in YYYY-MM-DD format.')
  .refine((s) => {
    const p = parseDateOnly(s);
    return p !== null && p.y >= MIN_YEAR && p.y <= MAX_YEAR;
  }, `Year must be between ${MIN_YEAR} and ${MAX_YEAR}.`);

const note = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z
    .string()
    .trim()
    .max(500, 'Must be at most 500 characters.')
    .refine((s) => !/\p{Cc}/u.test(s.replace(/[\n\r\t]/g, '')), 'Contains unsupported control characters.')
    .refine((s) => !looksLikeCardData(s), CARD_DATA_MESSAGE)
    .nullable(),
).optional();

/**
 * A payment is something the USER records. Nothing here is verified against the provider or a bank.
 * `amountMinor` is required on purpose (no guessing from the current price); `paidOn` defaults to today.
 */
export const createPaymentSchema = z.strictObject({
  amountMinor: z.number().int('Amount must be a whole number of minor units.').min(1, 'Amount must be greater than zero.').max(MAX_AMOUNT_MINOR, 'Amount is too large.'),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine(isSupportedCurrency, `Unsupported currency. Supported: ${CURRENCY_CODES.join(', ')}.`)
    .optional(),
  paidOn: dateOnly.optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  /** Which renewal (a date on the subscription's schedule) this payment covers. Enables the duplicate guard. */
  forBillingDate: dateOnly.optional(),
  note,
  /** Also move the subscription's next billing date past `forBillingDate` (paid payments, active subscriptions). */
  advanceNextBillingDate: z.boolean().optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const listPaymentsQuerySchema = z.strictObject({
  page: intParam(1, 100_000),
  pageSize: intParam(1, MAX_PAGE_SIZE),
});
export const listPriceHistoryQuerySchema = listPaymentsQuerySchema;

export const upcomingQuerySchema = z.strictObject({ count: intParam(1, 24) });

export interface PaymentDto {
  id: string;
  subscriptionId: string;
  amountMinor: number;
  currency: CurrencyCode;
  paidOn: DateOnly;
  status: PaymentStatus;
  forBillingDate: DateOnly | null;
  note: string | null;
  /** Always "user_entered": SubCycle does not verify charges with any provider or bank. */
  source: 'user_entered';
  createdAt: string;
}

export interface PriceChangeDto {
  id: string;
  subscriptionId: string;
  oldAmountMinor: number;
  newAmountMinor: number;
  currency: CurrencyCode;
  effectiveOn: DateOnly;
  note: string | null;
  createdAt: string;
}
