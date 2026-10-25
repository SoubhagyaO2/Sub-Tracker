import { CURRENCIES, MAX_AMOUNT_MINOR, type CurrencyCode } from '@subcycle/shared';

export type MoneyParse = { ok: true; minor: number } | { ok: false; message: string };

/**
 * Parses what a person types ("649", "1,299.50", ".5") into integer MINOR units using exact string
 * arithmetic: no floats are involved, so no rounding can creep into stored money.
 */
export function parseMoneyInput(raw: string, currency: CurrencyCode): MoneyParse {
  const exponent = CURRENCIES[currency];
  const fail = (message: string): MoneyParse => ({ ok: false, message });
  let s = raw.trim().replace(/\s/g, '');
  if (s === '') return fail('Enter an amount.');
  if (s.includes(',')) {
    const intPart = s.split('.')[0] ?? '';
    if (!/^\d{1,3}(,\d{3})+$/.test(intPart)) return fail('Use digits and an optional decimal point, for example 649.00.');
    s = s.replace(/,/g, '');
  }
  if (s.startsWith('.')) s = `0${s}`;
  if (!/^\d+(\.\d+)?$/.test(s)) return fail('Use digits and an optional decimal point, for example 649.00.');
  const [whole = '0', fraction = ''] = s.split('.');
  if (fraction.length > exponent) {
    return fail(exponent === 0 ? `${currency} has no decimal places.` : `${currency} allows at most ${exponent} decimal places.`);
  }
  const minor = Number(BigInt(whole + fraction.padEnd(exponent, '0')));
  if (!Number.isSafeInteger(minor) || minor > MAX_AMOUNT_MINOR) return fail('That amount is too large.');
  if (minor <= 0) return fail('Amount must be greater than zero.');
  return { ok: true, minor };
}

/** Minor units to a plain decimal string for form fields ("64900" + INR -> "649.00"), via string arithmetic. */
export function minorToInput(minor: number, currency: CurrencyCode): string {
  const exponent = CURRENCIES[currency];
  if (exponent === 0) return String(minor);
  const digits = String(minor).padStart(exponent + 1, '0');
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/** Display formatting only. The currency CODE is always returned alongside the formatted number. */
export function formatMoney(minor: number, currency: CurrencyCode | string): { amount: string; code: string } {
  const exponent = currency in CURRENCIES ? CURRENCIES[currency as CurrencyCode] : 2;
  const amount = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(minor / 10 ** exponent);
  return { amount, code: currency };
}

/** "₹649.00 INR": amount and code together, for places that need a plain string (aria-labels, tests). */
export function moneyText(minor: number, currency: CurrencyCode | string): string {
  const { amount, code } = formatMoney(minor, currency);
  return `${amount} ${code}`;
}

/** Preferred currency first, then alphabetical. Currencies are never merged. */
export function orderCurrencies(codes: Iterable<string>, preferred?: string): string[] {
  return [...new Set(codes)].sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b)));
}
