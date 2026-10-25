import {
  addDays,
  effectiveNextBillingDate,
  firstOccurrenceAfter,
  firstOccurrenceOnOrAfter,
  isOccurrence,
  maxDate,
  nextOccurrences,
  occurrence,
  occurrencesBetween,
  planAdvance,
  rollForwardDate,
  type AdvanceInput,
  type BillingFrequency,
  type SubscriptionStatus,
} from '@subcycle/shared';
import { describe, expect, it } from 'vitest';

const FREQS: BillingFrequency[] = ['weekly', 'monthly', 'quarterly', 'yearly'];

describe('firstOccurrenceOnOrAfter: matches a brute-force reference for every day', () => {
  // Anchors chosen to hit every clamping case: 28th, 29th, 30th, 31st, Feb 29, year-end, month-end of 30-day months.
  const anchors = ['2030-01-28', '2030-01-29', '2030-01-30', '2030-01-31', '2032-02-29', '2030-12-31', '2030-04-30', '2031-03-31'];
  const naive = (anchor: string, f: BillingFrequency, date: string): string => {
    for (let n = 0; n < 5000; n++) {
      const d = occurrence(anchor, f, n);
      if (d >= date) return d;
    }
    throw new Error('not found');
  };

  it.each(FREQS)('%s: every date from 10 days before the anchor to ~3 years after', (f) => {
    for (const anchor of anchors) {
      let date = addDays(anchor, -10);
      for (let i = 0; i < 1100; i++, date = addDays(date, 1)) {
        const got = firstOccurrenceOnOrAfter(anchor, f, date);
        expect(got, `${f} anchor=${anchor} date=${date}`).toBe(naive(anchor, f, date));
        expect(got >= date).toBe(true);
        expect(isOccurrence(anchor, f, got)).toBe(true);
      }
    }
  });

  it('firstOccurrenceAfter is strictly greater; the predecessor of the result is not after the input', () => {
    for (const f of FREQS) {
      for (const anchor of anchors) {
        let d = anchor;
        for (let n = 0; n < 60; n++) {
          const next = firstOccurrenceAfter(anchor, f, d);
          expect(next > d, `${f} ${anchor} ${d}`).toBe(true);
          expect(next).toBe(occurrence(anchor, f, n + 1)); // consecutive: no occurrence is skipped
          d = next;
        }
      }
    }
  });
});

describe('month-end, leap-year and year-boundary behaviour', () => {
  it('monthly 31st: clamps in short months and snaps back (never drifts)', () => {
    const a = '2030-01-31';
    expect(firstOccurrenceOnOrAfter(a, 'monthly', '2030-02-01')).toBe('2030-02-28');
    expect(firstOccurrenceOnOrAfter(a, 'monthly', '2030-02-28')).toBe('2030-02-28'); // inclusive
    expect(firstOccurrenceAfter(a, 'monthly', '2030-02-28')).toBe('2030-03-31'); // back to the 31st, not the 28th
    expect(firstOccurrenceAfter(a, 'monthly', '2030-03-31')).toBe('2030-04-30');
    expect(firstOccurrenceAfter(a, 'monthly', '2030-04-30')).toBe('2030-05-31');
    expect(firstOccurrenceOnOrAfter(a, 'monthly', '2032-02-10')).toBe('2032-02-29'); // leap year
  });
  it('rollForwardDate follows the anchor schedule from any stale stored date', () => {
    const a = '2030-01-31';
    expect(rollForwardDate(a, 'monthly', '2030-01-31', '2030-03-01')).toBe('2030-03-31');
    expect(rollForwardDate(a, 'monthly', '2030-01-31', '2030-04-01')).toBe('2030-04-30');
    expect(rollForwardDate(a, 'monthly', '2030-02-28', '2030-03-31')).toBe('2030-03-31'); // today is the boundary: stays today
    expect(rollForwardDate(a, 'monthly', '2030-02-28', '2030-04-01')).toBe('2030-04-30');
  });
  it('quarterly, yearly (incl. Feb 29) and weekly', () => {
    expect(rollForwardDate('2030-08-30', 'quarterly', '2030-08-30', '2031-01-01')).toBe('2031-02-28');
    expect(rollForwardDate('2030-08-30', 'quarterly', '2030-08-30', '2031-03-01')).toBe('2031-05-30');
    expect(rollForwardDate('2032-02-29', 'yearly', '2032-02-29', '2033-01-01')).toBe('2033-02-28');
    expect(rollForwardDate('2032-02-29', 'yearly', '2032-02-29', '2033-03-01')).toBe('2034-02-28');
    expect(rollForwardDate('2032-02-29', 'yearly', '2032-02-29', '2036-01-01')).toBe('2036-02-29');
    expect(rollForwardDate('2030-01-31', 'weekly', '2030-01-31', '2030-02-01')).toBe('2030-02-07');
    expect(rollForwardDate('2030-01-31', 'weekly', '2030-01-31', '2030-02-07')).toBe('2030-02-07');
    expect(rollForwardDate('2030-12-26', 'weekly', '2030-12-26', '2031-01-01')).toBe('2031-01-02'); // across the year
  });
  it('never moves backwards: a future stored date is kept; a date before the anchor resolves to the anchor', () => {
    expect(rollForwardDate('2030-01-31', 'monthly', '2030-06-30', '2030-03-01')).toBe('2030-06-30');
    expect(firstOccurrenceOnOrAfter('2030-06-15', 'monthly', '2029-01-01')).toBe('2030-06-15');
  });
  it('every rolled date is on the anchor schedule', () => {
    for (const f of FREQS) {
      for (const a of ['2030-01-29', '2030-01-31', '2032-02-29']) {
        for (const today of ['2030-03-01', '2031-07-17', '2033-02-28', '2036-02-29']) {
          expect(isOccurrence(a, f, rollForwardDate(a, f, a, today)), `${f} ${a} ${today}`).toBe(true);
        }
      }
    }
  });
});

describe('occurrencesBetween / nextOccurrences', () => {
  it('monthly 31st across a leap February; inclusive bounds', () => {
    expect(occurrencesBetween('2030-01-31', 'monthly', '2032-01-01', '2032-04-30')).toEqual(['2032-01-31', '2032-02-29', '2032-03-31', '2032-04-30']);
    expect(occurrencesBetween('2030-01-31', 'monthly', '2030-02-28', '2030-02-28')).toEqual(['2030-02-28']);
    expect(occurrencesBetween('2030-01-31', 'monthly', '2030-02-01', '2030-02-27')).toEqual([]);
  });
  it('yearly Feb 29 over seven years', () => {
    expect(occurrencesBetween('2032-02-29', 'yearly', '2031-01-01', '2037-12-31')).toEqual([
      '2032-02-29', '2033-02-28', '2034-02-28', '2035-02-28', '2036-02-29', '2037-02-28',
    ]);
  });
  it('weekly produces several dates inside one month; quarterly respects its step', () => {
    expect(occurrencesBetween('2030-01-03', 'weekly', '2030-01-01', '2030-01-31')).toEqual(['2030-01-03', '2030-01-10', '2030-01-17', '2030-01-24', '2030-01-31']);
    expect(occurrencesBetween('2030-01-31', 'quarterly', '2030-01-01', '2030-12-31')).toEqual(['2030-01-31', '2030-04-30', '2030-07-31', '2030-10-31']);
  });
  it('dates before the anchor are never produced; reversed ranges are empty', () => {
    expect(occurrencesBetween('2030-06-15', 'monthly', '2030-01-01', '2030-07-31')).toEqual(['2030-06-15', '2030-07-15']);
    expect(occurrencesBetween('2030-06-15', 'monthly', '2030-08-01', '2030-07-01')).toEqual([]);
  });
  it('honours the limit and has a hard cap', () => {
    expect(occurrencesBetween('2030-01-01', 'weekly', '2030-01-01', '2130-01-01', 3)).toHaveLength(3);
    expect(occurrencesBetween('2030-01-01', 'weekly', '2030-01-01', '2130-01-01')).toHaveLength(1000);
  });
  it('nextOccurrences returns consecutive dates starting on or after `from`', () => {
    expect(nextOccurrences('2030-01-31', 'monthly', '2030-02-15', 4)).toEqual(['2030-02-28', '2030-03-31', '2030-04-30', '2030-05-31']);
    expect(nextOccurrences('2030-01-31', 'monthly', '2030-02-28', 1)).toEqual(['2030-02-28']);
  });
});

describe('effectiveNextBillingDate (computed on read)', () => {
  const base = { anchorDate: '2030-01-05', billingFrequency: 'monthly' as const, nextBillingDate: '2030-01-05' };
  const eff = (status: SubscriptionStatus, extra = {}) => effectiveNextBillingDate({ ...base, status, ...extra }, '2030-01-15');
  it('active rolls forward; a current date is unchanged', () => {
    expect(eff('active')).toBe('2030-02-05');
    expect(eff('active', { nextBillingDate: '2030-02-05' })).toBe('2030-02-05');
  });
  it('trial keeps its stored date even after it has passed (never auto-converted)', () => {
    expect(eff('trial')).toBe('2030-01-05');
  });
  it('paused, cancelled and archived have none', () => {
    for (const s of ['paused', 'cancelled', 'archived'] as const) expect(eff(s)).toBeNull();
  });
});

describe('planAdvance (recording a payment may advance the stored date)', () => {
  const base: AdvanceInput = {
    subscriptionStatus: 'active', paymentStatus: 'paid', anchorDate: '2030-02-01', billingFrequency: 'monthly',
    storedNext: '2030-02-01', forBillingDate: '2030-02-01', today: '2030-01-15',
  };
  const plan = (o: Partial<AdvanceInput> = {}) => planAdvance({ ...base, ...o });

  it('paying the upcoming renewal moves to the next occurrence on the same schedule', () => {
    expect(plan()).toEqual({ ok: true, nextBillingDate: '2030-03-01', changed: true });
  });
  it('month-end: stays on the 31st schedule (Feb 28 -> Mar 31, not Mar 28)', () => {
    expect(plan({ anchorDate: '2030-01-31', storedNext: '2030-02-28', forBillingDate: '2030-02-28' })).toEqual({ ok: true, nextBillingDate: '2030-03-31', changed: true });
    expect(plan({ anchorDate: '2030-01-31', storedNext: '2030-03-31', forBillingDate: '2030-03-31', today: '2030-03-31' })).toEqual({ ok: true, nextBillingDate: '2030-04-30', changed: true });
  });
  it('yearly leap day, quarterly and weekly', () => {
    expect(plan({ billingFrequency: 'yearly', anchorDate: '2028-02-29', storedNext: '2031-02-28', forBillingDate: '2031-02-28' })).toMatchObject({ nextBillingDate: '2032-02-29' });
    expect(plan({ billingFrequency: 'quarterly', anchorDate: '2030-01-31', storedNext: '2030-04-30', forBillingDate: '2030-04-30' })).toMatchObject({ nextBillingDate: '2030-07-31' });
    expect(plan({ billingFrequency: 'weekly', anchorDate: '2030-01-10', storedNext: '2030-01-17', forBillingDate: '2030-01-17' })).toMatchObject({ nextBillingDate: '2030-01-24' });
  });
  it('is never in the past: a stale stored date lands on the first occurrence on/after today', () => {
    // stored Feb 1 is long stale on Apr 10; paying the Feb 1 renewal jumps to May 1, not Mar 1.
    expect(plan({ storedNext: '2030-02-01', forBillingDate: '2030-02-01', today: '2030-04-10' })).toEqual({ ok: true, nextBillingDate: '2030-05-01', changed: true });
  });
  it('never moves backwards: paying an older renewal while the stored date is already ahead is a no-op', () => {
    expect(plan({ storedNext: '2030-03-01', forBillingDate: '2030-02-01' })).toEqual({ ok: true, nextBillingDate: '2030-03-01', changed: false });
  });
  it('cannot skip ahead: a renewal after the upcoming one is rejected', () => {
    const r = plan({ forBillingDate: '2030-03-01' });
    expect(r).toMatchObject({ ok: false, path: 'forBillingDate' });
  });
  it('rejects non-paid payments, non-active subscriptions, missing or off-schedule dates', () => {
    expect(plan({ paymentStatus: 'failed' })).toMatchObject({ ok: false, path: 'advanceNextBillingDate' });
    expect(plan({ paymentStatus: 'refunded' })).toMatchObject({ ok: false });
    for (const s of ['trial', 'paused', 'cancelled', 'archived'] as const) {
      expect(plan({ subscriptionStatus: s }), s).toMatchObject({ ok: false, path: 'advanceNextBillingDate' });
    }
    expect(plan({ forBillingDate: null })).toMatchObject({ ok: false, path: 'forBillingDate' });
    expect(plan({ forBillingDate: '2030-02-02' })).toMatchObject({ ok: false, path: 'forBillingDate' });
  });
});

it('maxDate picks the latest', () => {
  expect(maxDate('2030-01-01', '2030-03-01', '2030-02-01')).toBe('2030-03-01');
});
