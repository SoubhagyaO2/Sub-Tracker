import { dateInZone, diffDays, parseDateOnly, type DateOnly } from '@subcycle/shared';

/**
 * Billing dates are calendar dates with no time zone. They are formatted from UTC midnight so the
 * browser's own zone can never shift them; the user's zone only decides what "today" is.
 */
export function formatDate(date: DateOnly, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const p = parseDateOnly(date);
  if (!p) return date;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    weekday: opts.weekday === false ? undefined : 'short',
    day: 'numeric',
    month: 'short',
    year: opts.year === false ? undefined : 'numeric',
  }).format(new Date(Date.UTC(p.y, p.m - 1, p.d)));
}

export function formatMonthShort(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short' }).format(new Date(Date.UTC(y!, m! - 1, 1)));
}

export function formatMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short', year: '2-digit' }).format(new Date(Date.UTC(y!, m! - 1, 1)));
}

/** "Today", "Tomorrow", "in 5 days", "Yesterday", "5 days ago". */
export function relativeDay(date: DateOnly, today: DateOnly): string {
  const n = diffDays(date, today);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

export const browserTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Today in the user's zone; falls back to the browser's zone if the stored one is unusable. */
export function todayIn(timeZone: string, now: Date = new Date()): DateOnly {
  try {
    return dateInZone(now, timeZone);
  } catch {
    return dateInZone(now, browserTimeZone());
  }
}

export function greetingFor(timeZone: string, now: Date = new Date()): string {
  let hour: number;
  try {
    hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now));
  } catch {
    hour = now.getHours();
  }
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

/** First day (YYYY-MM-01) of the month `monthsBack` months before today's month. */
export function monthStartBack(today: DateOnly, monthsBack: number): DateOnly {
  const p = parseDateOnly(today)!;
  const total = p.y * 12 + (p.m - 1) - monthsBack;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}
