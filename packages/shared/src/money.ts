import { CURRENCIES, type CurrencyCode } from './currency.js';
import type { BillingFrequency } from './dates.js';

export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

/** Exact rational factor to a monthly equivalent: [numerator, denominator]. */
export const MONTHLY_FACTOR: Record<BillingFrequency, readonly [number, number]> = {
  weekly: [52, 12],
  monthly: [1, 1],
  quarterly: [1, 3],
  yearly: [1, 12],
};

/**
 * Monthly equivalent in minor units, rounded half-up, using integer arithmetic only.
 * This is a per-row display estimate; totals must sum exact fractions first and round once.
 */
export function monthlyEquivalentMinor(amountMinor: number, frequency: BillingFrequency): number {
  const [num, den] = MONTHLY_FACTOR[frequency];
  return Math.floor((2 * amountMinor * num + den) / (2 * den));
}

/** Multiplier from one charge to a YEAR of charges. Equals 12 x the monthly factor, so it stays an integer. */
const YEARLY_MULTIPLIER: Record<BillingFrequency, bigint> = { weekly: 52n, monthly: 12n, quarterly: 4n, yearly: 1n };

/**
 * Exact totals for subscriptions that share ONE currency (never mix currencies: there is no FX conversion).
 * Sums exact yearly amounts first, then rounds the monthly figure once (half-up), so per-row rounding errors
 * cannot accumulate. Both figures are ESTIMATES derived from current prices, not money actually paid.
 */
export function totalsMinor(items: readonly { amountMinor: number; billingFrequency: BillingFrequency }[]): {
  monthlyEquivalentMinor: number;
  annualizedMinor: number;
} {
  let yearly = 0n;
  for (const i of items) yearly += BigInt(i.amountMinor) * YEARLY_MULTIPLIER[i.billingFrequency];
  return { monthlyEquivalentMinor: Number((2n * yearly + 12n) / 24n), annualizedMinor: Number(yearly) };
}

/** "64900" + INR -> "649.00 INR", by exact string arithmetic. For plain-text contexts such as email. */
export function formatMinorPlain(minor: number, currency: CurrencyCode): string {
  const exponent = CURRENCIES[currency];
  if (exponent === 0) return `${minor} ${currency}`;
  const digits = String(minor).padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)} ${currency}`;
}
