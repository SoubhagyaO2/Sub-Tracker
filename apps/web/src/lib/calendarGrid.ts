import { addDays, addMonths, daysInMonth, diffDays, formatDateOnly, parseDateOnly, type DateOnly } from '@subcycle/shared';

/** "YYYY-MM". */
export type YearMonth = string;

export const monthOf = (date: DateOnly): YearMonth => date.slice(0, 7);
export const firstOfMonth = (ym: YearMonth): DateOnly => `${ym}-01`;

export function lastOfMonth(ym: YearMonth): DateOnly {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return formatDateOnly(y, m, daysInMonth(y, m));
}

/** The month n months after (or before, if negative) `ym`. */
export const shiftMonth = (ym: YearMonth, n: number): YearMonth => monthOf(addMonths(firstOfMonth(ym), n));

/** 0 = Monday ... 6 = Sunday, matching the API's definition of a week. */
export const mondayIndex = (date: DateOnly): number => (((diffDays(date, '1970-01-01') + 3) % 7) + 7) % 7;

/** The month as rows of 7 days starting on Monday; days outside the month are null. */
export function monthWeeks(ym: YearMonth): (DateOnly | null)[][] {
  const first = firstOfMonth(ym);
  const last = lastOfMonth(ym);
  const cells: (DateOnly | null)[] = Array.from({ length: mondayIndex(first) }, () => null);
  for (let d = first; d <= last; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
}

/** Monday..Sunday column headings in the browser's language ("Mon" with the full name for screen readers). */
export function weekdayHeadings(): { short: string; long: string }[] {
  const monday = '2030-01-14'; // a Monday
  return Array.from({ length: 7 }, (_, i) => {
    const p = parseDateOnly(addDays(monday, i))!;
    const at = new Date(Date.UTC(p.y, p.m - 1, p.d));
    return {
      short: new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short' }).format(at),
      long: new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'long' }).format(at),
    };
  });
}

export function formatMonthTitle(ym: YearMonth): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(y, m - 1, 1)));
}
