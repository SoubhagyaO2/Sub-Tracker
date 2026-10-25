import {
  ACTION_FROM,
  CURRENCIES,
  STATUSES,
  STATUS_ACTIONS,
  TransitionError,
  addDays,
  addMonths,
  allowedActions,
  applyTransition,
  createSubscriptionSchema,
  diffDays,
  isOccurrence,
  isSupportedCurrency,
  looksLikeCardData,
  monthlyEquivalentMinor,
  occurrence,
  parseDateOnly,
  updateSubscriptionSchema,
  validateSubscriptionState,
  type BillingFrequency,
  type StatusAction,
  type SubscriptionStatus,
  type TransitionCurrent,
} from '@subcycle/shared';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/clock.js';
import { todayInZone } from '../src/today.js';

describe('date-only arithmetic', () => {
  it('rejects invalid calendar dates and non-canonical formats', () => {
    for (const bad of ['2030-02-30', '2029-02-29', '2030-13-01', '2030-00-10', '2030-1-1', ' 2030-01-01', '2030-01-01T00:00:00Z', '', 'tomorrow']) {
      expect(parseDateOnly(bad), bad).toBeNull();
    }
    expect(parseDateOnly('2032-02-29')).toEqual({ y: 2032, m: 2, d: 29 });
  });

  it('month-end: a 31st anchor never drifts to the 28th', () => {
    const expected = ['2030-01-31', '2030-02-28', '2030-03-31', '2030-04-30', '2030-05-31', '2030-06-30', '2030-07-31'];
    expected.forEach((d, n) => expect(addMonths('2030-01-31', n)).toBe(d));
    expect(addMonths('2032-01-31', 1)).toBe('2032-02-29'); // leap year
    expect(occurrence('2030-01-31', 'monthly', 13)).toBe('2031-02-28');
    expect(occurrence('2030-01-31', 'monthly', 14)).toBe('2031-03-31'); // back on the 31st
    expect(occurrence('2030-01-31', 'monthly', 25)).toBe('2032-02-29');
  });

  it('29th and 30th anchors clamp only in the short month', () => {
    expect(occurrence('2030-01-29', 'monthly', 1)).toBe('2030-02-28');
    expect(occurrence('2030-01-29', 'monthly', 2)).toBe('2030-03-29');
    expect(occurrence('2030-01-30', 'monthly', 1)).toBe('2030-02-28');
    expect(occurrence('2030-01-30', 'monthly', 2)).toBe('2030-03-30');
    expect(occurrence('2032-01-30', 'monthly', 1)).toBe('2032-02-29');
  });

  it('quarterly and yearly follow the anchor', () => {
    expect(occurrence('2030-08-30', 'quarterly', 1)).toBe('2030-11-30');
    expect(occurrence('2030-08-30', 'quarterly', 2)).toBe('2031-02-28');
    expect(occurrence('2030-08-30', 'quarterly', 3)).toBe('2031-05-30');
    expect(occurrence('2032-02-29', 'yearly', 1)).toBe('2033-02-28');
    expect(occurrence('2032-02-29', 'yearly', 4)).toBe('2036-02-29');
    expect(occurrence('2030-12-31', 'yearly', 1)).toBe('2031-12-31');
  });

  it('weekly is exactly 7 days, across month and year boundaries', () => {
    expect(occurrence('2030-01-31', 'weekly', 1)).toBe('2030-02-07');
    expect(occurrence('2030-12-30', 'weekly', 1)).toBe('2031-01-06');
    expect(occurrence('2030-03-05', 'weekly', 5)).toBe('2030-04-09');
  });

  it('addDays/diffDays are unaffected by DST (pure UTC epoch days)', () => {
    expect(addDays('2030-03-09', 1)).toBe('2030-03-10'); // US spring-forward date
    expect(addDays('2030-11-02', 1)).toBe('2030-11-03'); // US fall-back date
    expect(addDays('2030-03-30', 2)).toBe('2030-04-01'); // EU spring-forward weekend
    expect(diffDays('2031-01-01', '2030-01-01')).toBe(365);
    expect(diffDays('2032-03-01', '2031-03-01')).toBe(366);
  });

  const anchors = ['2030-01-28', '2030-01-29', '2030-01-30', '2030-01-31', '2032-02-29', '2030-12-31', '2030-03-31'];
  const freqs: BillingFrequency[] = ['weekly', 'monthly', 'quarterly', 'yearly'];

  it.each(freqs)('every generated %s occurrence is recognised, and non-occurrences are not (all anchors, 120 steps)', (f) => {
    for (const a of anchors) {
      const dates = new Set<string>();
      for (let n = 0; n < 120; n++) {
        const d = occurrence(a, f, n);
        dates.add(d);
        expect(isOccurrence(a, f, d), `${a} ${f} n=${n} -> ${d}`).toBe(true);
        if (n > 0) expect(d > occurrence(a, f, n - 1), 'strictly increasing').toBe(true);
      }
      // A date one day off any occurrence is not an occurrence, unless it is itself in the series.
      for (const d of [...dates].slice(0, 30)) {
        const off = addDays(d, 1);
        expect(isOccurrence(a, f, off), `${a} ${f} ${off}`).toBe(dates.has(off));
      }
    }
  });

  it('isOccurrence: dates before the anchor, wrong steps and wrong days are rejected', () => {
    expect(isOccurrence('2030-01-31', 'monthly', '2030-02-28')).toBe(true);
    expect(isOccurrence('2030-01-31', 'monthly', '2030-02-27')).toBe(false);
    expect(isOccurrence('2030-01-31', 'monthly', '2029-12-31')).toBe(false); // before anchor
    expect(isOccurrence('2030-01-31', 'quarterly', '2030-02-28')).toBe(false); // wrong step
    expect(isOccurrence('2030-01-31', 'quarterly', '2030-04-30')).toBe(true);
    expect(isOccurrence('2030-01-31', 'yearly', '2031-01-31')).toBe(true);
    expect(isOccurrence('2030-01-31', 'weekly', '2030-02-08')).toBe(false);
    expect(isOccurrence('2032-02-29', 'yearly', '2033-02-28')).toBe(true);
    expect(isOccurrence('2032-02-29', 'yearly', '2033-03-01')).toBe(false);
  });
});

describe('monthly equivalent (integer arithmetic, half-up)', () => {
  it.each([
    [64900, 'monthly', 64900],
    [1_200_000, 'yearly', 100_000],
    [30_000, 'quarterly', 10_000],
    [999, 'weekly', 4329], // 999*52/12 = 4329 exactly
    [100, 'weekly', 433], // 433.33 -> 433
    [1, 'quarterly', 0], // 0.33 -> 0
    [2, 'quarterly', 1], // 0.67 -> 1
    [6, 'yearly', 1], // 0.5 rounds half up
    [5, 'yearly', 0], // 0.4167 -> 0
    [1_000_000_000_000, 'weekly', 4_333_333_333_333], // max amount, no precision loss
  ] as const)('%i %s -> %i', (amount, freq, expected) => {
    expect(monthlyEquivalentMinor(amount, freq)).toBe(expected);
  });
});

describe('currency table', () => {
  it('accepts supported ISO codes with correct exponents', () => {
    expect(isSupportedCurrency('INR')).toBe(true);
    expect(CURRENCIES.JPY).toBe(0);
    expect(CURRENCIES.USD).toBe(2);
  });
  it('rejects unsupported, lower-case, malformed codes and prototype keys', () => {
    for (const c of ['XXX', 'inr', 'INRR', 'IN', '', ' INR', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(isSupportedCurrency(c), c).toBe(false);
    }
  });
});

describe('payment-card lookalike guard', () => {
  const rejected = [
    '4111111111111111',
    '4111 1111 1111 1111',
    '4111-1111-1111-1111',
    '4111  1111  1111  1111',
    '4111.1111.1111.1111',
    '4111_1111_1111_1111',
    '4242424242424241', // fails Luhn but still resembles a card number
    '1234567890123', // 13 digits
    '1234567890123456789', // 19 digits
    'HDFC 4111111111111111',
    'card: 5500 0000 0000 0004 exp 12/30',
    '378282246310005', // Amex length
    'cvv 123',
    'CVV: 1234',
    'cvc2 123',
    'security code 123',
    'Security Code - 4567',
  ];
  const accepted = [
    '',
    'HDFC card ••12',
    'Visa ending 4242',
    'Amex *1005',
    'Personal card',
    'Card 1234',
    'Card 2024 renewal',
    'UPI',
    '123456789012', // 12 digits
    'phone 9876543210',
    'Work card (1234)',
  ];
  it.each(rejected)('rejects %j', (s) => expect(looksLikeCardData(s)).toBe(true));
  it.each(accepted)('accepts %j', (s) => expect(looksLikeCardData(s)).toBe(false));
});

describe('status state machine (pure)', () => {
  const base: TransitionCurrent = {
    status: 'active',
    statusBeforeArchive: null,
    anchorDate: '2030-02-01',
    nextBillingDate: '2030-02-01',
    startDate: '2030-01-01',
    cancelledOn: null,
  };
  const today = '2030-01-15';
  const cur = (status: SubscriptionStatus, extra: Partial<TransitionCurrent> = {}): TransitionCurrent => ({
    ...base,
    status,
    statusBeforeArchive: status === 'archived' ? 'active' : null,
    cancelledOn: status === 'cancelled' ? '2030-01-10' : null,
    ...extra,
  });
  // Minimal valid payload per action so only the transition rule is under test.
  const payload = (action: StatusAction, status: SubscriptionStatus) =>
    action === 'restore' && status === 'cancelled' ? { action, nextBillingDate: '2030-03-01' } : { action };

  const matrix = STATUSES.flatMap((s) => STATUS_ACTIONS.map((a) => [s, a, ACTION_FROM[a].includes(s)] as const));
  it.each(matrix)('%s + %s -> allowed=%s', (status, action, allowed) => {
    const run = () => applyTransition(cur(status), payload(action, status), today);
    if (allowed) expect(run).not.toThrow();
    else {
      expect(run).toThrow(TransitionError);
      try { run(); } catch (e) { expect((e as TransitionError).kind).toBe('invalid_transition'); }
    }
  });

  it('allowedActions mirrors the table', () => {
    expect(allowedActions('active')).toEqual(['pause', 'cancel', 'archive']);
    expect(allowedActions('trial')).toEqual(['convert', 'cancel', 'archive']);
    expect(allowedActions('paused')).toEqual(['resume', 'cancel', 'archive']);
    expect(allowedActions('cancelled')).toEqual(['archive', 'restore']);
    expect(allowedActions('archived')).toEqual(['restore']);
  });

  it('archive remembers the previous status and restore returns to it', () => {
    for (const s of ['active', 'trial', 'paused', 'cancelled'] as const) {
      const archived = applyTransition(cur(s), { action: 'archive' }, today);
      expect(archived.status).toBe('archived');
      expect(archived.statusBeforeArchive).toBe(s);
      const restored = applyTransition({ ...cur('archived'), statusBeforeArchive: s, cancelledOn: archived.cancelledOn }, { action: 'restore' }, today);
      expect(restored.status).toBe(s);
      expect(restored.statusBeforeArchive).toBeNull();
    }
  });

  it('cancel: defaults to today, cannot be in the future or before the start date', () => {
    expect(applyTransition(cur('active'), { action: 'cancel' }, today).cancelledOn).toBe(today);
    expect(applyTransition(cur('active'), { action: 'cancel', cancelledOn: '2030-01-01' }, today).cancelledOn).toBe('2030-01-01'); // == start date, boundary ok
    expect(() => applyTransition(cur('active'), { action: 'cancel', cancelledOn: '2030-01-16' }, today)).toThrow(/future/);
    expect(() => applyTransition(cur('active'), { action: 'cancel', cancelledOn: '2029-12-31' }, today)).toThrow(/start date/);
  });

  it('restoring a cancelled subscription requires a new, non-past billing date and clears cancelledOn', () => {
    expect(() => applyTransition(cur('cancelled'), { action: 'restore' }, today)).toThrow(/Provide the next billing date/);
    expect(() => applyTransition(cur('cancelled'), { action: 'restore', nextBillingDate: '2030-01-14' }, today)).toThrow(/past/);
    const r = applyTransition(cur('cancelled'), { action: 'restore', nextBillingDate: today }, today); // today is the boundary: allowed
    expect(r).toMatchObject({ status: 'active', cancelledOn: null, nextBillingDate: today, anchorDate: today });
  });

  it('resume/convert keep the schedule if still current, require a date once it has passed', () => {
    expect(applyTransition(cur('paused'), { action: 'resume' }, today)).toMatchObject({ status: 'active', anchorDate: '2030-02-01', nextBillingDate: '2030-02-01' });
    const stale = cur('paused', { nextBillingDate: '2030-01-10', anchorDate: '2030-01-10' });
    expect(() => applyTransition(stale, { action: 'resume' }, today)).toThrow(/has passed/);
    expect(applyTransition(stale, { action: 'resume', nextBillingDate: '2030-02-10' }, today)).toMatchObject({ nextBillingDate: '2030-02-10', anchorDate: '2030-02-10' });
    expect(applyTransition(cur('trial'), { action: 'convert' }, today).status).toBe('active');
  });

  it('rejects parameters that do not belong to the action', () => {
    expect(() => applyTransition(cur('active'), { action: 'pause', cancelledOn: '2030-01-10' }, today)).toThrow(/cancelledOn only applies/);
    expect(() => applyTransition(cur('active'), { action: 'pause', nextBillingDate: '2030-03-01' }, today)).toThrow(/does not apply/);
    expect(() => applyTransition(cur('active'), { action: 'cancel', nextBillingDate: '2030-03-01' }, today)).toThrow(/does not apply/);
    expect(() => applyTransition(cur('archived', { statusBeforeArchive: 'cancelled' }), { action: 'restore', nextBillingDate: '2030-03-01' }, today)).toThrow(/doesn’t take/);
  });
});

describe('cross-field subscription rules', () => {
  const ok = { status: 'active', billingFrequency: 'monthly', anchorDate: '2030-01-31', nextBillingDate: '2030-02-28', startDate: '2030-01-01', trialEndDate: null } as const;
  it('accepts a clamped month-end date that lies on the anchor schedule', () => {
    expect(validateSubscriptionState(ok, { today: '2030-01-15', checkNotPast: true })).toEqual([]);
  });
  it('rejects dates off the schedule (this is what prevents persisted drift)', () => {
    const issues = validateSubscriptionState({ ...ok, nextBillingDate: '2030-02-27' }, { today: '2030-01-15', checkNotPast: true });
    expect(issues.map((i) => i.path)).toContain('nextBillingDate');
  });
  it('only enforces "not in the past" when asked, and only for active/trial', () => {
    const past = { ...ok, anchorDate: '2030-01-05', nextBillingDate: '2030-01-05' };
    expect(validateSubscriptionState(past, { today: '2030-01-15', checkNotPast: false })).toEqual([]);
    expect(validateSubscriptionState(past, { today: '2030-01-15', checkNotPast: true })).toHaveLength(1);
    expect(validateSubscriptionState({ ...past, status: 'paused' }, { today: '2030-01-15', checkNotPast: true })).toEqual([]);
  });
});

describe('request schemas', () => {
  const minimal = { name: 'X', amountMinor: 100, billingFrequency: 'monthly', nextBillingDate: '2030-02-01' };
  it('normalizes currency case and trims text; treats empty optional text as null', () => {
    const r = createSubscriptionSchema.parse({ ...minimal, name: '  Netflix  ', currency: ' inr ', notes: '   ', websiteUrl: '' });
    expect(r).toMatchObject({ name: 'Netflix', currency: 'INR', notes: null, websiteUrl: null });
  });
  it.each([
    ['float amount', { amountMinor: 1.5 }],
    ['string amount', { amountMinor: '649' }],
    ['zero amount', { amountMinor: 0 }],
    ['negative amount', { amountMinor: -5 }],
    ['over max', { amountMinor: 1_000_000_000_001 }],
    ['unsupported currency', { currency: 'XXX' }],
    ['bad frequency', { billingFrequency: 'daily' }],
    ['bad category', { category: 'crypto' }],
    ['status cancelled at creation', { status: 'cancelled' }],
    ['unknown key', { userId: 'x' }],
    ['bad url scheme', { websiteUrl: 'javascript:alert(1)' }],
    ['url with credentials', { websiteUrl: 'https://user:pw@example.com' }],
    ['card number in label', { paymentMethodLabel: '4111 1111 1111 1111' }],
  ])('rejects %s', (_n, patch) => {
    expect(createSubscriptionSchema.safeParse({ ...minimal, ...patch }).success).toBe(false);
  });
  it('accepts the maximum amount exactly', () => {
    expect(createSubscriptionSchema.safeParse({ ...minimal, amountMinor: 1_000_000_000_000 }).success).toBe(true);
  });
  it('update schema forbids status and empty bodies', () => {
    expect(updateSubscriptionSchema.safeParse({}).success).toBe(false);
    expect(updateSubscriptionSchema.safeParse({ status: 'cancelled' }).success).toBe(false);
    expect(updateSubscriptionSchema.safeParse({ notes: null }).success).toBe(true);
  });
});

describe('todayInZone (deterministic clock, DST-aware)', () => {
  it('the same instant is a different calendar date in different zones', () => {
    const c = new FakeClock('2030-01-15T20:00:00Z');
    expect(todayInZone(c, 'Asia/Kolkata')).toBe('2030-01-16'); // 01:30 next day
    expect(todayInZone(c, 'UTC')).toBe('2030-01-15');
    expect(todayInZone(c, 'America/Los_Angeles')).toBe('2030-01-15');
  });
  it('US spring-forward (2030-03-10): midnight boundary uses PDT offset after the change', () => {
    const c = new FakeClock('2030-03-11T06:59:59Z'); // 23:59:59 PDT on the 10th
    expect(todayInZone(c, 'America/Los_Angeles')).toBe('2030-03-10');
    c.set('2030-03-11T07:00:00Z'); // 00:00:00 PDT on the 11th
    expect(todayInZone(c, 'America/Los_Angeles')).toBe('2030-03-11');
  });
  it('US fall-back (2030-11-03): midnight boundary uses PST offset after the change', () => {
    const c = new FakeClock('2030-11-04T07:59:59Z'); // 23:59:59 PST on the 3rd
    expect(todayInZone(c, 'America/Los_Angeles')).toBe('2030-11-03');
    c.set('2030-11-04T08:00:00Z');
    expect(todayInZone(c, 'America/Los_Angeles')).toBe('2030-11-04');
  });
  it('half-hour offset zone and zones ahead of UTC across the new year', () => {
    const c = new FakeClock('2030-12-31T18:30:00Z');
    expect(todayInZone(c, 'Asia/Kolkata')).toBe('2031-01-01'); // exactly 00:00 IST
    c.set('2030-12-31T18:29:59Z');
    expect(todayInZone(c, 'Asia/Kolkata')).toBe('2030-12-31');
    expect(todayInZone(c, 'Pacific/Auckland')).toBe('2031-01-01');
  });
});
