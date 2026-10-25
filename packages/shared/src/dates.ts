/**
 * Date-only (calendar date) arithmetic on "YYYY-MM-DD" strings.
 * No time zones and no JS Date local-time behaviour: everything goes through UTC epoch days,
 * so results cannot shift with the machine's zone or DST.
 */
export type DateOnly = string;
export type BillingFrequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

const RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function parseDateOnly(s: string): { y: number; m: number; d: number } | null {
  const match = RE.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/**
 * The calendar date of `instant` in an IANA time zone (DST-aware via the zone database).
 * The one place "today" is derived, so the browser and the server always agree for a given user.
 */
export function dateInZone(instant: Date, timeZone: string): DateOnly {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const isValidDateOnly = (s: string): boolean => parseDateOnly(s) !== null;

const pad = (n: number, width: number) => String(n).padStart(width, '0');
export const formatDateOnly = (y: number, m: number, d: number): DateOnly => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;

function epochDay(s: DateOnly): number {
  const p = parseDateOnly(s);
  if (!p) throw new RangeError(`Invalid date: ${s}`);
  return Date.UTC(p.y, p.m - 1, p.d) / DAY_MS;
}

function fromEpochDay(n: number): DateOnly {
  const dt = new Date(n * DAY_MS);
  return formatDateOnly(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export const addDays = (s: DateOnly, days: number): DateOnly => fromEpochDay(epochDay(s) + days);

/** a - b in whole days. */
export const diffDays = (a: DateOnly, b: DateOnly): number => epochDay(a) - epochDay(b);

/** ISO date strings sort chronologically, so plain comparison is correct. */
export const compareDates = (a: DateOnly, b: DateOnly): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Adds k whole months to the anchor, keeping the anchor's day-of-month where the target month has it
 * and clamping to the month's last day otherwise. It is always computed from the ANCHOR, never from a
 * previous (already clamped) result, so a 31st-of-month anchor does not drift to the 28th.
 */
export function addMonths(anchor: DateOnly, k: number): DateOnly {
  const p = parseDateOnly(anchor);
  if (!p) throw new RangeError(`Invalid date: ${anchor}`);
  const total = p.y * 12 + (p.m - 1) + k;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return formatDateOnly(y, m, Math.min(p.d, daysInMonth(y, m)));
}

const MONTH_STEP = { monthly: 1, quarterly: 3, yearly: 12 } as const;

/** The n-th (n >= 0) billing date of the series defined by anchor + frequency. */
export function occurrence(anchor: DateOnly, frequency: BillingFrequency, n: number): DateOnly {
  if (frequency === 'weekly') return addDays(anchor, 7 * n);
  return addMonths(anchor, MONTH_STEP[frequency] * n);
}

/** True when `date` is a billing date of the series (including the anchor itself). */
export function isOccurrence(anchor: DateOnly, frequency: BillingFrequency, date: DateOnly): boolean {
  const a = parseDateOnly(anchor);
  const t = parseDateOnly(date);
  if (!a || !t) return false;
  if (frequency === 'weekly') {
    const diff = diffDays(date, anchor);
    return diff >= 0 && diff % 7 === 0;
  }
  const months = (t.y - a.y) * 12 + (t.m - a.m);
  return months >= 0 && months % MONTH_STEP[frequency] === 0 && t.d === Math.min(a.d, daysInMonth(t.y, t.m));
}
