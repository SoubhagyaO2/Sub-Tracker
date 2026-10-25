/**
 * Guard for the free-text "payment method label". SubCycle must never store card data, so anything
 * that resembles a card number or security code is rejected. This is a conservative heuristic, not a
 * Luhn check: a 16-digit number that fails Luhn still "resembles" a card number and is refused.
 */

// 13-19 digits, optionally separated by up to 3 spaces/dots/dashes/underscores between digits,
// and not part of a longer digit run. (Masked suffixes such as "••12" or "ending 4242" are fine.)
const CARD_NUMBER_LIKE = /(?<!\d)\d(?:[\s._-]{0,3}\d){12,18}(?!\d)/u;

// "CVV 123", "cvc: 4567", "security code - 123"
const SECURITY_CODE_LIKE = /\b(?:cvv2?|cvc2?|cid|security\s*code)\b\D{0,10}\d{3,4}(?!\d)/iu;

export function looksLikeCardData(label: string): boolean {
  return CARD_NUMBER_LIKE.test(label) || SECURITY_CODE_LIKE.test(label);
}

export const CARD_DATA_MESSAGE =
  'Don’t enter card numbers or security codes. A short label such as “HDFC card ••12” is enough.';
