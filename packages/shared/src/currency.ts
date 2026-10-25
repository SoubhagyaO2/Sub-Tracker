/**
 * Supported ISO-4217 currencies and their minor-unit exponents (digits after the decimal point).
 * Amounts are always stored and transmitted as integer minor units (e.g. paise, cents, yen).
 */
export const CURRENCIES = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AUD: 2,
  CAD: 2,
  SGD: 2,
  AED: 2,
  CHF: 2,
  CNY: 2,
  HKD: 2,
  NZD: 2,
  SEK: 2,
  BRL: 2,
  MXN: 2,
  ZAR: 2,
  JPY: 0,
  KRW: 0,
} as const satisfies Record<string, 0 | 2>;

export type CurrencyCode = keyof typeof CURRENCIES;
export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];
export const DEFAULT_CURRENCY: CurrencyCode = 'INR';

export const isSupportedCurrency = (code: string): code is CurrencyCode =>
  Object.prototype.hasOwnProperty.call(CURRENCIES, code);

export const minorUnitExponent = (code: CurrencyCode): number => CURRENCIES[code];
