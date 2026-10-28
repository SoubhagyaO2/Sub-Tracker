import {
  MAX_CALENDAR_RANGE_DAYS,
  analyticsQuerySchema,
  bucketStart,
  buildEstimate,
  buildProjection,
  calendarQuerySchema,
  collectOccurrences,
  enumerateBuckets,
  formatMinorPlain,
  listRemindersQuerySchema,
  planReminders,
  renewalTotals,
  updatePreferencesSchema,
  zonedInstant,
  type CalendarSub,
  type ReminderPrefs,
  type ReminderSub,
} from '@subcycle/shared';
import { describe, expect, it } from 'vitest';

describe('zonedInstant: the instant a wall-clock hour happens in a zone', () => {
  it.each([
    ['2030-01-15', 9, 'Asia/Kolkata', '2030-01-15T03:30:00.000Z'],
    ['2030-01-15', 9, 'America/Los_Angeles', '2030-01-15T17:00:00.000Z'], // PST (UTC-8)
    ['2030-07-15', 9, 'America/Los_Angeles', '2030-07-15T16:00:00.000Z'], // PDT (UTC-7)
    ['2030-01-31', 0, 'Pacific/Auckland', '2030-01-30T11:00:00.000Z'], // NZDT is UTC+13: midnight is the previous UTC day
    ['2030-12-31', 23, 'Asia/Kolkata', '2030-12-31T17:30:00.000Z'],
    ['2030-03-10', 1, 'America/Los_Angeles', '2030-03-10T09:00:00.000Z'], // just before the US spring-forward
    ['2030-03-10', 3, 'America/Los_Angeles', '2030-03-10T10:00:00.000Z'], // just after it (PDT)
  ])('%s %i:00 in %s -> %s', (date, hour, zone, iso) => {
    expect(zonedInstant(date, hour, zone).toISOString()).toBe(iso);
  });

  it('a wall time that does not exist (spring-forward gap) moves FORWARD, deterministically', () => {
    expect(zonedInstant('2030-03-10', 2, 'America/Los_Angeles').toISOString()).toBe('2030-03-10T10:00:00.000Z'); // 03:00 PDT
    expect(zonedInstant('2030-03-31', 1, 'Europe/London').toISOString()).toBe('2030-03-31T01:00:00.000Z'); // 02:00 BST
  });
  it('a wall time that happens twice (fall-back) resolves to the FIRST occurrence', () => {
    expect(zonedInstant('2030-11-03', 1, 'America/Los_Angeles').toISOString()).toBe('2030-11-03T08:00:00.000Z'); // 01:00 PDT, not 01:00 PST
    expect(zonedInstant('2030-10-27', 1, 'Europe/London').toISOString()).toBe('2030-10-27T00:00:00.000Z'); // 01:00 BST
  });
  it('rejects unknown zones and invalid dates', () => {
    expect(() => zonedInstant('2030-01-01', 9, 'Mars/Olympus')).toThrow(RangeError);
    expect(() => zonedInstant('2030-02-30', 9, 'UTC')).toThrow(RangeError);
  });
});

describe('planReminders (pure)', () => {
  const prefs: ReminderPrefs = { timeZone: 'Asia/Kolkata', leadDays: 3, hour: 9, inApp: true, email: false, trial: true };
  const sub = (o: Partial<ReminderSub> = {}): ReminderSub => ({
    id: 's1', status: 'active', billingFrequency: 'monthly', anchorDate: '2030-02-01', nextBillingDate: '2030-02-01', trialEndDate: null,
    reminderLeadDays: null, remindersEnabled: true, ...o,
  });
  const targets = (subs: ReminderSub[], p = prefs, today = '2030-01-15') => planReminders(subs, p, today).map((r) => `${r.kind}:${r.targetDate}:${r.channel}:${r.leadDays}`);

  it('one reminder per upcoming renewal, lead days before, at the reminder hour in the user’s zone', () => {
    const r = planReminders([sub()], prefs, '2030-01-15');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'renewal', targetDate: '2030-02-01', channel: 'in_app', leadDays: 3 });
    expect(r[0]!.remindAt.toISOString()).toBe('2030-01-29T03:30:00.000Z'); // Jan 29, 09:00 IST
  });
  it('a subscription’s own lead time overrides the default; 0 means the day itself', () => {
    expect(planReminders([sub({ reminderLeadDays: 7 })], prefs, '2030-01-15')[0]!.remindAt.toISOString()).toBe('2030-01-25T03:30:00.000Z');
    const zero = planReminders([sub({ reminderLeadDays: 0 })], prefs, '2030-01-15')[0]!;
    expect(zero.leadDays).toBe(0);
    expect(zero.remindAt.toISOString()).toBe('2030-02-01T03:30:00.000Z');
  });
  it('creates one row per ENABLED channel; email rows exist even if email cannot be delivered (the delivery step records why)', () => {
    expect(targets([sub()], { ...prefs, email: true })).toEqual(['renewal:2030-02-01:in_app:3', 'renewal:2030-02-01:email:3']);
    expect(targets([sub()], { ...prefs, inApp: false, email: true })).toEqual(['renewal:2030-02-01:email:3']);
    expect(targets([sub()], { ...prefs, inApp: false, email: false })).toEqual([]);
  });
  it('only active subscriptions get renewal reminders; trials get a trial-end reminder; nothing for paused/cancelled/archived/disabled', () => {
    expect(targets([sub({ status: 'paused' }), sub({ status: 'cancelled' }), sub({ status: 'archived' }), sub({ remindersEnabled: false })])).toEqual([]);
    expect(targets([sub({ status: 'trial', trialEndDate: '2030-01-20', nextBillingDate: '2030-01-20', anchorDate: '2030-01-20' })])).toEqual(['trial_end:2030-01-20:in_app:3']);
    expect(targets([sub({ status: 'trial', trialEndDate: '2030-01-20' })], { ...prefs, trial: false })).toEqual([]);
    expect(targets([sub({ status: 'trial', trialEndDate: '2030-01-14' })])).toEqual([]); // an ended trial is not reminded about
  });
  it('a renewal that was paid ahead (saved date moved past it) gets no reminder', () => {
    expect(targets([sub({ anchorDate: '2030-02-01', nextBillingDate: '2030-03-01' })])).toEqual([]); // Feb 1 skipped, Mar 1 is beyond the 30-day horizon
    expect(targets([sub({ anchorDate: '2030-01-20', nextBillingDate: '2030-02-20' })], prefs, '2030-02-01')).toEqual(['renewal:2030-02-20:in_app:3']);
  });
  it('weekly subscriptions get one reminder per renewal', () => {
    const r = targets([sub({ billingFrequency: 'weekly', anchorDate: '2030-01-17', nextBillingDate: '2030-01-17' })]);
    expect(r.slice(0, 3)).toEqual(['renewal:2030-01-17:in_app:3', 'renewal:2030-01-24:in_app:3', 'renewal:2030-01-31:in_app:3']);
    expect(r.length).toBeGreaterThan(4);
  });
  it('month-end: follows the anchor (Feb 28, Mar 31), and the leap-year February', () => {
    const s = sub({ anchorDate: '2030-01-31', nextBillingDate: '2030-02-28' });
    expect(targets([s], prefs, '2030-02-20')).toEqual(['renewal:2030-02-28:in_app:3']); // Mar 31 is beyond today + lead + 30 days
    expect(targets([s], prefs, '2030-03-10')).toEqual(['renewal:2030-03-31:in_app:3']); // later: the 31st again, not the 28th
    const leap = sub({ anchorDate: '2032-01-31', nextBillingDate: '2032-01-31' });
    expect(targets([leap], prefs, '2032-02-10')).toContain('renewal:2032-02-29:in_app:3');
  });
  it('year boundary: December 31 anchor continues into January', () => {
    const s = sub({ anchorDate: '2030-12-31', nextBillingDate: '2030-12-31' });
    expect(targets([s], prefs, '2030-12-29')).toEqual(['renewal:2030-12-31:in_app:3', 'renewal:2031-01-31:in_app:3']);
  });
  it('quarterly and yearly (Feb 29) schedules', () => {
    const q = sub({ billingFrequency: 'quarterly', anchorDate: '2030-01-31', nextBillingDate: '2030-04-30' });
    expect(targets([q], prefs, '2030-04-20')).toEqual(['renewal:2030-04-30:in_app:3']);
    const y = sub({ billingFrequency: 'yearly', anchorDate: '2032-02-29', nextBillingDate: '2033-02-28' });
    expect(targets([y], prefs, '2033-02-20')).toEqual(['renewal:2033-02-28:in_app:3']);
  });
  it('a renewal TODAY is planned (its instant may already be past: it will be delivered at the next pass)', () => {
    const r = planReminders([sub({ nextBillingDate: '2030-01-15', anchorDate: '2030-01-15' })], prefs, '2030-01-15');
    expect(r.map((x) => x.targetDate)).toEqual(['2030-01-15', '2030-02-15']);
    expect(r[0]!.remindAt.getTime()).toBeLessThan(new Date('2030-01-15T10:00:00Z').getTime());
  });
  it('is DST-correct: a 02:00 reminder on the US spring-forward date lands at 03:00 PDT', () => {
    const la: ReminderPrefs = { ...prefs, timeZone: 'America/Los_Angeles', hour: 2, leadDays: 0 };
    const r = planReminders([sub({ anchorDate: '2030-03-10', nextBillingDate: '2030-03-10' })], la, '2030-03-01');
    expect(r[0]!.remindAt.toISOString()).toBe('2030-03-10T10:00:00.000Z');
  });
  it('an unknown zone throws, even when nothing would be planned (so callers can report the user)', () => {
    expect(() => planReminders([], { ...prefs, timeZone: 'Mars/Olympus' }, '2030-01-15')).toThrow(RangeError);
    expect(() => planReminders([sub()], { ...prefs, timeZone: 'Nope' }, '2030-01-15')).toThrow(RangeError);
  });
  it('is deterministic', () => {
    expect(planReminders([sub(), sub({ id: 's2' })], { ...prefs, email: true }, '2030-01-15')).toEqual(planReminders([sub(), sub({ id: 's2' })], { ...prefs, email: true }, '2030-01-15'));
  });
});

describe('collectOccurrences (the calendar), pure and read-only', () => {
  const s = (o: Partial<CalendarSub> = {}): CalendarSub => ({
    id: 's1', name: 'Netflix', category: 'video', icon: null, amountMinor: 64900, currency: 'INR', billingFrequency: 'monthly', status: 'active',
    anchorDate: '2030-02-01', nextBillingDate: '2030-02-01', trialEndDate: null, ...o,
  });
  const dates = (subs: CalendarSub[], from: string, to: string, today = '2030-01-15') => collectOccurrences(subs, { from, to }, today).map((o) => `${o.date}:${o.kind}`);

  it.each([
    ['monthly month-end', { anchorDate: '2030-01-31', nextBillingDate: '2030-01-31' }, '2030-01-15', '2030-05-31', ['2030-01-31', '2030-02-28', '2030-03-31', '2030-04-30', '2030-05-31']],
    ['monthly across a leap February', { anchorDate: '2032-01-31', nextBillingDate: '2032-01-31' }, '2032-01-20', '2032-04-30', ['2032-01-31', '2032-02-29', '2032-03-31', '2032-04-30']],
    ['quarterly', { billingFrequency: 'quarterly' as const, anchorDate: '2030-01-31', nextBillingDate: '2030-01-31' }, '2030-01-15', '2030-12-31', ['2030-01-31', '2030-04-30', '2030-07-31', '2030-10-31']],
    ['yearly with a leap-day anchor', { billingFrequency: 'yearly' as const, anchorDate: '2032-02-29', nextBillingDate: '2033-02-28' }, '2033-01-01', '2036-12-31', ['2033-02-28', '2034-02-28', '2035-02-28', '2036-02-29']],
    ['weekly (several in one month)', { billingFrequency: 'weekly' as const, anchorDate: '2030-01-17', nextBillingDate: '2030-01-17' }, '2030-01-15', '2030-02-14', ['2030-01-17', '2030-01-24', '2030-01-31', '2030-02-07', '2030-02-14']],
    ['weekly across the year boundary', { billingFrequency: 'weekly' as const, anchorDate: '2030-12-19', nextBillingDate: '2030-12-19' }, '2030-12-15', '2031-01-10', ['2030-12-19', '2030-12-26', '2031-01-02', '2031-01-09']],
  ])('%s', (_n, over, from, to, expected) => {
    expect(dates([s(over)], from, to, from)).toEqual(expected.map((d) => `${d}:renewal`));
  });

  it('never returns dates before today, and never before the saved next billing date (a renewal paid ahead is not shown again)', () => {
    const paidAhead = s({ anchorDate: '2030-01-01', nextBillingDate: '2030-03-01' }); // Jan/Feb renewals already handled
    expect(dates([paidAhead], '2030-01-01', '2030-04-30', '2030-01-15')).toEqual(['2030-03-01:renewal', '2030-04-01:renewal']);
    expect(dates([s()], '2029-12-01', '2030-02-28', '2030-02-10')).toEqual([]); // saved Feb 1 is stale; the next occurrence (Mar 1) is outside the range
  });
  it('a stale saved date is treated as the schedule from today (same dates as the roll-forward would pick)', () => {
    const stale = s({ anchorDate: '2030-01-05', nextBillingDate: '2030-01-05' });
    expect(dates([stale], '2030-01-01', '2030-03-31', '2030-01-15')).toEqual(['2030-02-05:renewal', '2030-03-05:renewal']);
  });
  it('status semantics: active renews, trial shows its end, paused/cancelled/archived are absent', () => {
    const trial = s({ id: 't', name: 'Trial', status: 'trial', trialEndDate: '2030-01-20', nextBillingDate: '2030-01-20', anchorDate: '2030-01-20' });
    const subs = [s({ id: 'a' }), trial, s({ id: 'p', status: 'paused' }), s({ id: 'c', status: 'cancelled' }), s({ id: 'x', status: 'archived' })];
    expect(collectOccurrences(subs, { from: '2030-01-15', to: '2030-02-28' }, '2030-01-15').map((o) => `${o.subscriptionId}:${o.kind}:${o.date}`)).toEqual([
      't:trial_end:2030-01-20', 'a:renewal:2030-02-01',
    ]);
    const ended = s({ status: 'trial', trialEndDate: '2030-01-10', nextBillingDate: '2030-01-10' });
    expect(dates([ended], '2030-01-01', '2030-02-28')).toEqual([]); // SubCycle doesn't guess what happened after a trial ended
  });
  it('range bounds are inclusive; ordering is by date then name then id', () => {
    const subs = [s({ id: 'b', name: 'Zed', nextBillingDate: '2030-02-01' }), s({ id: 'a', name: 'Alpha', nextBillingDate: '2030-02-01' }), s({ id: 'c', name: 'Mid', anchorDate: '2030-02-10', nextBillingDate: '2030-02-10' })];
    expect(collectOccurrences(subs, { from: '2030-02-01', to: '2030-02-10' }, '2030-01-15').map((o) => o.name)).toEqual(['Alpha', 'Zed', 'Mid']);
    expect(dates(subs, '2030-02-02', '2030-02-09')).toEqual([]);
  });
  it('renewal totals are per currency and exclude trial endings', () => {
    const occ = collectOccurrences(
      [s({ id: 'a', amountMinor: 100 }), s({ id: 'b', amountMinor: 250, currency: 'USD' }), s({ id: 'c', amountMinor: 5, currency: 'USD' }), s({ id: 't', status: 'trial', trialEndDate: '2030-01-20', nextBillingDate: '2030-01-20', amountMinor: 999 })],
      { from: '2030-01-15', to: '2030-02-28' }, '2030-01-15',
    );
    expect(renewalTotals(occ)).toEqual([{ currency: 'INR', renewalCount: 1, amountMinor: 100 }, { currency: 'USD', renewalCount: 2, amountMinor: 255 }]);
  });
  it('a year-long weekly range stays within the per-subscription cap', () => {
    const n = collectOccurrences([s({ billingFrequency: 'weekly', anchorDate: '2030-01-15', nextBillingDate: '2030-01-15' })], { from: '2030-01-15', to: '2031-01-15' }, '2030-01-15').length;
    expect(n).toBe(53);
  });
});

describe('request schemas', () => {
  it('calendar: validates dates, order and the 366-day cap (inclusive)', () => {
    expect(calendarQuerySchema.safeParse({}).success).toBe(true);
    expect(calendarQuerySchema.safeParse({ from: '2030-01-01', to: '2030-12-31' }).success).toBe(true); // 365 days
    expect(calendarQuerySchema.safeParse({ from: '2030-01-01', to: '2031-01-01' }).success).toBe(true); // exactly 366 inclusive days: the maximum
    expect(calendarQuerySchema.safeParse({ from: '2030-01-01', to: '2031-01-02' }).success).toBe(false); // 367
    expect(calendarQuerySchema.safeParse({ from: '2032-01-01', to: '2032-12-31' }).success).toBe(true); // a leap year is exactly 366
    expect(calendarQuerySchema.safeParse({ from: '2032-01-01', to: '2033-01-01' }).success).toBe(false); // 367
    expect(MAX_CALENDAR_RANGE_DAYS).toBe(366);
    for (const bad of [{ from: '2030-02-30' }, { to: 'tomorrow' }, { from: '2030-02-01', to: '2030-01-01' }, { from: '2101-01-01' }, { foo: 1 }, { from: 20300101 }]) {
      expect(calendarQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it('analytics: bucket enum, ordering, unknown keys', () => {
    expect(analyticsQuerySchema.safeParse({ from: '2030-01-01', to: '2030-06-30', bucket: 'week' }).success).toBe(true);
    for (const bad of [{ bucket: 'day' }, { from: '2030-06-01', to: '2030-01-01' }, { currency: 'INR' }, { from: 'x' }]) {
      expect(analyticsQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it('reminder list and preference schemas are strict', () => {
    expect(listRemindersQuerySchema.safeParse({ channel: 'email', status: 'sent,failed', unread: 'true', page: '2', pageSize: '10' }).success).toBe(true);
    for (const bad of [{ channel: 'sms' }, { status: 'done' }, { unread: 'false' }, { pageSize: '101' }, { userId: 'x' }, { status: '' }]) {
      expect(listRemindersQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(updatePreferencesSchema.safeParse({ reminderLeadDays: 0, reminderHour: 23, inAppReminders: false }).success).toBe(true);
    for (const bad of [{}, { reminderLeadDays: 61 }, { reminderLeadDays: -1 }, { reminderLeadDays: 1.5 }, { reminderHour: 24 }, { theme: 'blue' }, { timezone: 'EST' }, { currency: 'XXX' }, { emailRemindersEnabled: 'yes' }]) {
      expect(updatePreferencesSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('analytics buckets and builders (pure)', () => {
  it('month buckets start on the 1st; week buckets start on Monday', () => {
    expect(bucketStart('2030-01-31', 'month')).toBe('2030-01-01');
    expect(bucketStart('2030-01-16', 'week')).toBe('2030-01-14'); // Wednesday -> Monday
    expect(bucketStart('2030-01-14', 'week')).toBe('2030-01-14'); // Monday itself
    expect(bucketStart('2030-01-20', 'week')).toBe('2030-01-14'); // Sunday belongs to the week that started Monday
    expect(bucketStart('2031-01-01', 'week')).toBe('2030-12-30'); // the week spans the year boundary
    expect(bucketStart('2032-03-01', 'month')).toBe('2032-03-01');
  });
  it('enumerates every bucket from the one containing `from` to the one containing `to`, including empty ones', () => {
    expect(enumerateBuckets('2029-11-15', '2030-02-02', 'month')).toEqual(['2029-11-01', '2029-12-01', '2030-01-01', '2030-02-01']);
    expect(enumerateBuckets('2030-01-16', '2030-02-04', 'week')).toEqual(['2030-01-14', '2030-01-21', '2030-01-28', '2030-02-04']);
    expect(enumerateBuckets('2030-01-31', '2030-01-31', 'month')).toEqual(['2030-01-01']);
  });
  const sub = (o: Partial<CalendarSub> = {}): CalendarSub => ({
    id: 's', name: 'N', category: 'video', icon: null, amountMinor: 1000, currency: 'INR', billingFrequency: 'monthly', status: 'active',
    anchorDate: '2030-02-01', nextBillingDate: '2030-02-01', trialEndDate: null, ...o,
  });
  it('estimate: ACTIVE only, per currency, exact (summed before rounding), never mixing currencies', () => {
    const subs = [
      sub({ id: 'a', amountMinor: 100, billingFrequency: 'weekly' }), sub({ id: 'b', amountMinor: 100, billingFrequency: 'weekly' }), sub({ id: 'c', amountMinor: 100, billingFrequency: 'weekly' }),
      sub({ id: 'd', amountMinor: 500, currency: 'USD', category: 'music' }),
      sub({ id: 'e', amountMinor: 9999, status: 'trial', trialEndDate: '2030-02-01' }), sub({ id: 'f', amountMinor: 9999, status: 'paused' }),
      sub({ id: 'g', amountMinor: 9999, status: 'cancelled' }), sub({ id: 'h', amountMinor: 9999, status: 'archived' }),
    ];
    const e = buildEstimate(subs);
    expect(e.map((c) => c.currency)).toEqual(['INR', 'USD']);
    expect(e[0]).toMatchObject({ subscriptionCount: 3, monthlyEquivalentMinor: 1300, annualizedMinor: 15600 }); // 3 x 433.33 -> 1300, not 3 x 433
    expect(e[1]).toMatchObject({ subscriptionCount: 1, monthlyEquivalentMinor: 500, annualizedMinor: 6000 });
    expect(e[0]!.byCategory).toEqual([{ category: 'video', subscriptionCount: 3, monthlyEquivalentMinor: 1300, annualizedMinor: 15600, percent: 100 }]);
  });
  it('estimate: categories ordered by yearly cost with exact shares; top subscriptions limited to five', () => {
    const subs = [
      ...Array.from({ length: 7 }, (_, i) => sub({ id: `v${i}`, name: `V${i}`, amountMinor: 1000 + i * 100 })),
      sub({ id: 'm', name: 'Music', category: 'music', amountMinor: 30000, billingFrequency: 'yearly' }),
    ];
    const e = buildEstimate(subs)[0]!;
    expect(e.byCategory.map((c) => c.category)).toEqual(['video', 'music']); // video: 8400/month in total, far above music
    expect(Math.round(e.byCategory[0]!.percent + e.byCategory[1]!.percent)).toBe(100);
    expect(e.top).toHaveLength(5);
    expect(e.top[0]).toMatchObject({ name: 'Music', amountMinor: 30000, monthlyEquivalentMinor: 2500 }); // 30000/yr is the largest single yearly cost (V6 is 19200/yr)
  });
  it('projection: 7/30/90-day windows are inclusive, per currency, trial endings counted separately', () => {
    const subs = [
      sub({ id: 'a', amountMinor: 100, nextBillingDate: '2030-01-22', anchorDate: '2030-01-22' }), // exactly day 7
      sub({ id: 'b', amountMinor: 200, currency: 'USD', nextBillingDate: '2030-01-23', anchorDate: '2030-01-23' }), // day 8
      sub({ id: 't', status: 'trial', trialEndDate: '2030-01-16', nextBillingDate: '2030-01-16', anchorDate: '2030-01-16', amountMinor: 777 }),
    ];
    const [w7, w30, w90] = buildProjection(subs, '2030-01-15');
    expect(w7).toMatchObject({ days: 7, to: '2030-01-22', trialEndCount: 1, currencies: [{ currency: 'INR', renewalCount: 1, amountMinor: 100 }] });
    expect(w30!.currencies).toEqual([{ currency: 'INR', renewalCount: 1, amountMinor: 100 }, { currency: 'USD', renewalCount: 1, amountMinor: 200 }]); // to Feb 14: only Jan 22 / Jan 23
    expect(w90!.currencies).toEqual([{ currency: 'INR', renewalCount: 3, amountMinor: 300 }, { currency: 'USD', renewalCount: 3, amountMinor: 600 }]); // to Apr 15: Jan, Feb, Mar
  });
  it('plain money text is exact', () => {
    expect(formatMinorPlain(64900, 'INR')).toBe('649.00 INR');
    expect(formatMinorPlain(5, 'USD')).toBe('0.05 USD');
    expect(formatMinorPlain(980, 'JPY')).toBe('980 JPY');
  });
});
