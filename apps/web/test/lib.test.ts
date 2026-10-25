import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request, setUnauthenticatedHandler } from '../src/api/client';
import {
  activeTotals, categoryBreakdown, recentPayments, recordedByMonth, renewalAmounts, upcomingRenewals, lastMonths,
} from '../src/lib/dashboard';
import { formatDate, greetingFor, monthStartBack, relativeDay, todayIn } from '../src/lib/dates';
import { mapApiError } from '../src/lib/forms';
import { formatMoney, minorToInput, moneyText, orderCurrencies, parseMoneyInput } from '../src/lib/money';
import { buildCreatePayload, buildUpdatePayload, emptyValues, valuesFromSubscription } from '../src/lib/subscriptionForm';
import { FakeServer, TODAY, fail, makePayment, makeSub, ok } from './helpers';

describe('parseMoneyInput (exact, no floats)', () => {
  it.each([
    ['649', 'INR', 64900],
    ['649.00', 'INR', 64900],
    ['649.5', 'INR', 64950],
    ['0.01', 'INR', 1],
    ['.5', 'INR', 50],
    ['1,299.50', 'INR', 129950],
    ['1,234,567', 'INR', 123456700],
    ['  12.30  ', 'USD', 1230],
    ['980', 'JPY', 980],
    ['10000000000.00', 'INR', 1_000_000_000_000], // the maximum
    ['0.29', 'USD', 29], // the classic float trap (0.29 * 100 = 28.999...)
    ['1.15', 'USD', 115],
  ])('%s %s -> %i minor units', (input, currency, minor) => {
    expect(parseMoneyInput(input, currency as 'INR')).toEqual({ ok: true, minor });
  });

  it.each([
    ['', 'INR', /Enter an amount/],
    ['abc', 'INR', /digits/],
    ['12.345', 'INR', /at most 2 decimal/],
    ['980.5', 'JPY', /no decimal places/],
    ['-5', 'INR', /digits/],
    ['0', 'INR', /greater than zero/],
    ['0.00', 'INR', /greater than zero/],
    ['1,23', 'INR', /digits/],
    ['12,34.50', 'INR', /digits/],
    ['1e5', 'INR', /digits/],
    ['10000000000.01', 'INR', /too large/],
    ['99999999999999999999', 'INR', /too large/],
  ])('rejects %j (%s)', (input, currency, message) => {
    const r = parseMoneyInput(input, currency as 'INR');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toMatch(message);
  });

  it('round-trips through the input form', () => {
    for (const [minor, cur] of [[64900, 'INR'], [5, 'INR'], [100, 'USD'], [980, 'JPY'], [1_000_000_000_000, 'INR']] as const) {
      expect(parseMoneyInput(minorToInput(minor, cur), cur)).toEqual({ ok: true, minor });
    }
    expect(minorToInput(5, 'INR')).toBe('0.05');
  });
});

describe('money display always carries the currency code', () => {
  it('formatMoney returns amount and code; moneyText joins them', () => {
    const m = formatMoney(64900, 'INR');
    expect(m.code).toBe('INR');
    expect(m.amount).toMatch(/649\.00/);
    expect(moneyText(1250, 'USD')).toMatch(/12\.50.*USD/);
    expect(moneyText(980, 'JPY')).toMatch(/980.*JPY/);
  });
  it('orders currencies with the preferred one first, never merging', () => {
    expect(orderCurrencies(['USD', 'INR', 'EUR', 'USD'], 'INR')).toEqual(['INR', 'EUR', 'USD']);
    expect(orderCurrencies(['USD', 'EUR'], 'INR')).toEqual(['EUR', 'USD']);
  });
});

describe('dates are displayed without time-zone shifts', () => {
  it('formats a date-only string as that exact calendar day', () => {
    expect(formatDate('2030-03-31', { weekday: false })).toMatch(/31/);
    expect(formatDate('2030-03-31', { weekday: false })).toMatch(/Mar/);
    expect(formatDate('2030-01-01', { weekday: false })).toMatch(/\b1\b/);
    expect(formatDate('2030-12-31', { weekday: false })).toMatch(/31/);
  });
  it('relative day labels', () => {
    expect(relativeDay('2030-01-15', TODAY)).toBe('Today');
    expect(relativeDay('2030-01-16', TODAY)).toBe('Tomorrow');
    expect(relativeDay('2030-01-14', TODAY)).toBe('Yesterday');
    expect(relativeDay('2030-01-20', TODAY)).toBe('in 5 days');
    expect(relativeDay('2030-01-10', TODAY)).toBe('5 days ago');
  });
  it('"today" and the greeting follow the USER’s zone, including date boundaries', () => {
    const t = new Date('2030-01-15T20:00:00Z');
    expect(todayIn('Asia/Kolkata', t)).toBe('2030-01-16');
    expect(todayIn('America/Los_Angeles', t)).toBe('2030-01-15');
    expect(todayIn('Mars/Olympus', t)).toMatch(/^\d{4}-\d{2}-\d{2}$/); // unusable stored zone falls back, never throws
    expect(greetingFor('Asia/Kolkata', new Date('2030-01-15T03:00:00Z'))).toBe('Good morning'); // 08:30 IST
    expect(greetingFor('Asia/Kolkata', new Date('2030-01-15T10:00:00Z'))).toBe('Good afternoon');
    expect(greetingFor('Asia/Kolkata', new Date('2030-01-15T15:00:00Z'))).toBe('Good evening');
  });
  it('month helpers', () => {
    expect(monthStartBack('2030-01-15', 11)).toBe('2029-02-01');
    expect(monthStartBack('2030-03-31', 0)).toBe('2030-03-01');
    expect(lastMonths('2030-01-15', 3)).toEqual(['2029-11', '2029-12', '2030-01']);
  });
});

describe('dashboard calculations: estimates, projections and recorded are kept apart', () => {
  it('totals are exact: fractions are summed first and rounded ONCE (not per row)', () => {
    const subs = [1, 2, 3].map(() => makeSub({ amountMinor: 100, billingFrequency: 'weekly' }));
    // each row alone rounds to 433; three rows: 3 x 433 = 1299 would be wrong. Exact: 3 x 100 x 52 / 12 = 1300.
    expect(subs.reduce((n, s) => n + s.monthlyEquivalentMinor, 0)).toBe(1299);
    expect(activeTotals(subs)).toEqual([{ currency: 'INR', count: 3, monthlyEquivalentMinor: 1300, annualizedMinor: 15600 }]);
  });
  it('only ACTIVE subscriptions count toward totals', () => {
    const subs = [
      makeSub({ amountMinor: 1000 }),
      makeSub({ amountMinor: 2000, status: 'trial', trialEndDate: '2030-02-01' }),
      makeSub({ amountMinor: 4000, status: 'paused' }),
      makeSub({ amountMinor: 8000, status: 'cancelled', cancelledOn: '2030-01-05' }),
      makeSub({ amountMinor: 16000, status: 'archived' }),
    ];
    expect(activeTotals(subs)[0]).toMatchObject({ count: 1, monthlyEquivalentMinor: 1000, annualizedMinor: 12000 });
  });
  it('currencies are never added together; the preferred currency comes first', () => {
    const subs = [makeSub({ amountMinor: 64900 }), makeSub({ amountMinor: 11900 }), makeSub({ amountMinor: 1000, currency: 'USD' })];
    const totals = activeTotals(subs, 'INR');
    expect(totals.map((t) => [t.currency, t.monthlyEquivalentMinor])).toEqual([['INR', 76800], ['USD', 1000]]);
    expect(activeTotals(subs, 'USD').map((t) => t.currency)).toEqual(['USD', 'INR']);
  });

  describe('upcoming renewals use the EFFECTIVE date', () => {
    const stale = makeSub({ name: 'Stale', nextBillingDate: '2030-01-05', anchorDate: '2030-01-05', effectiveNextBillingDate: '2030-02-05' });
    const soon = makeSub({ name: 'Soon', effectiveNextBillingDate: '2030-01-18', nextBillingDate: '2030-01-18' });
    const trial = makeSub({ name: 'Trial', status: 'trial', trialEndDate: '2030-01-20', nextBillingDate: '2030-01-20', effectiveNextBillingDate: '2030-01-20' });
    const paused = makeSub({ name: 'Paused', status: 'paused', nextBillingDate: '2030-01-17', effectiveNextBillingDate: null });
    const cancelled = makeSub({ name: 'Cancelled', status: 'cancelled', cancelledOn: '2030-01-01', effectiveNextBillingDate: null });
    const all = [stale, soon, trial, paused, cancelled, makeSub({ status: 'archived', effectiveNextBillingDate: null })];

    it('rolls a stale saved date to the calculated one, flags it as calculated, and sorts by date', () => {
      const r = upcomingRenewals(all, TODAY, 30);
      expect(r.map((x) => [x.subscription.name, x.date])).toEqual([['Soon', '2030-01-18'], ['Trial', '2030-01-20'], ['Stale', '2030-02-05']]);
      expect(r.find((x) => x.subscription.name === 'Stale')).toMatchObject({ calculated: true, daysAway: 21, kind: 'renewal' });
      expect(r.find((x) => x.subscription.name === 'Soon')?.calculated).toBe(false);
      expect(r.find((x) => x.subscription.name === 'Trial')?.kind).toBe('trial_end');
    });
    it('window bounds are inclusive; paused/cancelled/archived never appear', () => {
      expect(upcomingRenewals(all, TODAY, 7).map((x) => x.subscription.name)).toEqual(['Soon', 'Trial']);
      expect(upcomingRenewals([makeSub({ effectiveNextBillingDate: '2030-01-22', nextBillingDate: '2030-01-22' })], TODAY, 7)).toHaveLength(1); // exactly day 7
      expect(upcomingRenewals([makeSub({ effectiveNextBillingDate: '2030-01-23', nextBillingDate: '2030-01-23' })], TODAY, 7)).toHaveLength(0);
      expect(upcomingRenewals([makeSub({ effectiveNextBillingDate: '2030-01-15', nextBillingDate: '2030-01-15' })], TODAY, 7)).toHaveLength(1); // today
      expect(upcomingRenewals([makeSub({ effectiveNextBillingDate: '2030-01-14', nextBillingDate: '2030-01-14' })], TODAY, 7)).toHaveLength(0); // yesterday
    });
    it('window totals count charges only: a trial ending carries no charge yet, and currencies stay apart', () => {
      const usd = makeSub({ currency: 'USD', amountMinor: 500, effectiveNextBillingDate: '2030-01-16', nextBillingDate: '2030-01-16' });
      const r = upcomingRenewals([soon, trial, usd], TODAY, 7);
      expect(renewalAmounts(r, 'INR')).toEqual([{ currency: 'INR', amountMinor: 64900 }, { currency: 'USD', amountMinor: 500 }]);
    });
  });

  it('category breakdown (estimate) covers active subscriptions in one currency, with exact shares', () => {
    const subs = [
      makeSub({ category: 'video', amountMinor: 3000 }),
      makeSub({ category: 'music', amountMinor: 1000 }),
      makeSub({ category: 'music', amountMinor: 12000, billingFrequency: 'yearly' }), // 1000/month
      makeSub({ category: 'gaming', amountMinor: 99999, status: 'paused' }), // ignored
      makeSub({ category: 'video', amountMinor: 5, currency: 'USD' }), // other currency, ignored
    ];
    const rows = categoryBreakdown(subs, 'INR');
    expect(rows.map((r) => [r.category, r.monthlyEquivalentMinor])).toEqual([['video', 3000], ['music', 2000]]);
    expect(rows.map((r) => Math.round(r.percent))).toEqual([60, 40]);
  });

  describe('recorded spending comes only from payment records', () => {
    const rec = (p: Parameters<typeof makePayment>[0]) => ({ payment: makePayment(p), subscriptionId: 's1', subscriptionName: 'Netflix' });
    it('is paid minus refunded per month, ignores failed, other currencies and months outside the window', () => {
      const data = recordedByMonth(
        [
          rec({ paidOn: '2030-01-10', amountMinor: 64900 }),
          rec({ paidOn: '2030-01-12', amountMinor: 10000, status: 'refunded' }),
          rec({ paidOn: '2030-01-13', amountMinor: 99999, status: 'failed' }),
          rec({ paidOn: '2029-12-05', amountMinor: 20000 }),
          rec({ paidOn: '2030-01-11', amountMinor: 500, currency: 'USD' }),
          rec({ paidOn: '2028-01-01', amountMinor: 77777 }), // older than 12 months
        ],
        'INR',
        TODAY,
      );
      expect(data).toHaveLength(12);
      expect(data.at(-1)).toEqual({ month: '2030-01', netMinor: 54900 });
      expect(data.at(-2)).toEqual({ month: '2029-12', netMinor: 20000 });
      expect(data.slice(0, 10).every((d) => d.netMinor === 0)).toBe(true);
    });
    it('with NO payments every month is an honest zero: nothing is estimated or back-filled', () => {
      expect(recordedByMonth([], 'INR', TODAY).every((d) => d.netMinor === 0)).toBe(true);
    });
    it('recent payments: newest paid date first, then most recently recorded', () => {
      const r = recentPayments([
        rec({ id: 'a', paidOn: '2030-01-01', createdAt: '2030-01-01T00:00:00Z' }),
        rec({ id: 'b', paidOn: '2030-01-09', createdAt: '2030-01-09T01:00:00Z' }),
        rec({ id: 'c', paidOn: '2030-01-09', createdAt: '2030-01-09T05:00:00Z' }),
      ]);
      expect(r.map((x) => x.payment.id)).toEqual(['c', 'b', 'a']);
    });
  });
});

describe('subscription form payloads', () => {
  const ctx = { today: TODAY };
  const filled = (over = {}) => ({ ...emptyValues('INR'), name: 'Spotify', amountMinor: '119', nextBillingDate: '2030-02-10', ...over });

  describe('create', () => {
    it('sends minor units and only what was entered (no invented anchor, start or optional fields)', () => {
      const r = buildCreatePayload(filled(), ctx);
      expect(r).toEqual({
        ok: true,
        payload: { name: 'Spotify', amountMinor: 11900, billingFrequency: 'monthly', category: 'other', currency: 'INR', status: 'active', nextBillingDate: '2030-02-10' },
      });
    });
    it('includes optional fields when entered, trimming text and sending an emoji icon', () => {
      const r = buildCreatePayload(filled({ category: 'music', currency: 'USD', amountMinor: '9.99', paymentMethodLabel: ' HDFC ••12 ', icon: '🎵', usageLevel: 'often', anchorDate: '2030-01-31', nextBillingDate: '2030-02-28' }), ctx);
      expect(r.ok && r.payload).toMatchObject({ currency: 'USD', amountMinor: 999, paymentMethodLabel: 'HDFC ••12', icon: { kind: 'emoji', value: '🎵' }, usageLevel: 'often', anchorDate: '2030-01-31', nextBillingDate: '2030-02-28' });
    });
    it('a trial defaults the first charge to the trial end date', () => {
      const r = buildCreatePayload(filled({ status: 'trial', trialEndDate: '2030-01-29', nextBillingDate: '' }), ctx);
      expect(r.ok && r.payload).toMatchObject({ status: 'trial', trialEndDate: '2030-01-29', nextBillingDate: '2030-01-29' });
    });
    it.each([
      ['empty name', { name: '  ' }, 'name', /Enter a name/],
      ['bad amount', { amountMinor: '12.345' }, 'amountMinor', /decimal places/],
      ['no date', { nextBillingDate: '' }, 'nextBillingDate', /Enter the next billing date/],
      ['past date', { nextBillingDate: '2030-01-14' }, 'nextBillingDate', /past/],
      ['trial without end', { status: 'trial' as const, nextBillingDate: '2030-02-01' }, 'trialEndDate', /trial ends/i],
      ['off-schedule next date', { anchorDate: '2030-01-31', nextBillingDate: '2030-02-27' }, 'anchorDate', /schedule/],
      ['year out of range', { nextBillingDate: '2101-01-01' }, 'nextBillingDate', /Year must be/],
      ['invalid date', { nextBillingDate: '2030-02-30' }, 'nextBillingDate', /valid/],
      ['card number in label', { paymentMethodLabel: '4111 1111 1111 1111' }, 'paymentMethodLabel', /card numbers/],
    ])('rejects %s before any request', (_n, over, field, message) => {
      const r = buildCreatePayload(filled(over), ctx);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.errors[field]).toMatch(message);
    });
    it('today is allowed as the next billing date (boundary)', () => {
      expect(buildCreatePayload(filled({ nextBillingDate: TODAY }), ctx).ok).toBe(true);
    });
  });

  describe('edit sends ONLY what changed', () => {
    const month_end = makeSub({ anchorDate: '2030-01-31', nextBillingDate: '2030-02-28', effectiveNextBillingDate: '2030-02-28', notes: 'old', websiteUrl: 'https://a.example' });
    const base = valuesFromSubscription(month_end);

    it('REGRESSION: editing an unrelated field never sends dates, so a month-end anchor schedule cannot be reset', () => {
      const r = buildUpdatePayload({ ...base, name: 'Renamed' }, month_end, ctx);
      expect(r).toEqual({ ok: true, payload: { name: 'Renamed' } });
    });
    it('reports "nothing changed" instead of sending an empty PATCH', () => {
      expect(buildUpdatePayload(base, month_end, ctx)).toMatchObject({ ok: false, nothingChanged: true });
    });
    it('clears optional fields with null', () => {
      const r = buildUpdatePayload({ ...base, notes: '  ', websiteUrl: '' }, month_end, ctx);
      expect(r.ok && r.payload).toEqual({ notes: null, websiteUrl: null });
    });
    it('a changed amount (same currency) carries the price-change options', () => {
      expect(buildUpdatePayload({ ...base, amountMinor: '799.00' }, month_end, ctx).ok && true).toBe(true);
      const withNote = buildUpdatePayload({ ...base, amountMinor: '799', priceChangeNote: ' rise ', priceChangeEffectiveOn: '2030-01-10' }, month_end, ctx);
      expect(withNote.ok && withNote.payload).toEqual({ amountMinor: 79900, priceChangeNote: 'rise', priceChangeEffectiveOn: '2030-01-10' });
      const correction = buildUpdatePayload({ ...base, amountMinor: '799', recordPriceChange: false }, month_end, ctx);
      expect(correction.ok && correction.payload).toEqual({ amountMinor: 79900, recordPriceChange: false });
    });
    it('price-change fields are not sent when the currency changes, and a future effective date is refused', () => {
      const cur = buildUpdatePayload({ ...base, currency: 'USD', amountMinor: '9', priceChangeNote: 'x' }, month_end, ctx);
      expect(cur.ok && cur.payload).toEqual({ currency: 'USD', amountMinor: 900 });
      const future = buildUpdatePayload({ ...base, amountMinor: '799', priceChangeEffectiveOn: '2030-01-16' }, month_end, ctx);
      expect(future.ok === false && future.errors.priceChangeEffectiveOn).toMatch(/future/);
    });
    it('changing the frequency sends the next billing date too (the server needs it), and it must not be in the past', () => {
      const ok2 = buildUpdatePayload({ ...base, billingFrequency: 'yearly', nextBillingDate: '2031-02-28' }, month_end, ctx);
      expect(ok2.ok && ok2.payload).toEqual({ billingFrequency: 'yearly', nextBillingDate: '2031-02-28' });
      const same = buildUpdatePayload({ ...base, billingFrequency: 'weekly' }, month_end, ctx); // date untouched but must be re-sent
      expect(same.ok && same.payload).toMatchObject({ billingFrequency: 'weekly', nextBillingDate: '2030-02-28' });
      const stale = makeSub({ nextBillingDate: '2030-01-05', anchorDate: '2030-01-05', effectiveNextBillingDate: '2030-02-05' });
      const r = buildUpdatePayload({ ...valuesFromSubscription(stale), billingFrequency: 'yearly' }, stale, ctx);
      expect(r.ok === false && r.errors.nextBillingDate).toMatch(/past/);
    });
    it('a stale saved date does not block editing other fields', () => {
      const stale = makeSub({ nextBillingDate: '2030-01-05', anchorDate: '2030-01-05', effectiveNextBillingDate: '2030-02-05' });
      const r = buildUpdatePayload({ ...valuesFromSubscription(stale), notes: 'hello' }, stale, ctx);
      expect(r.ok && r.payload).toEqual({ notes: 'hello' });
    });
    it('a new next billing date is sent alone, so the server resets the schedule from it', () => {
      const r = buildUpdatePayload({ ...base, nextBillingDate: '2030-03-15' }, month_end, ctx);
      expect(r.ok && r.payload).toEqual({ nextBillingDate: '2030-03-15' });
    });
  });
});

describe('API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthenticatedHandler(null);
  });

  it('sends the CSRF header, JSON content type and same-origin credentials; no auth token of any kind', async () => {
    const server = new FakeServer().on('POST', '/api/thing', ok({ done: true })).install();
    await request('POST', '/api/thing', { body: { a: 1 } });
    const call = server.calls[0]!;
    expect(call.headers.get('X-SubCycle-Client')).toBe('web');
    expect(call.headers.get('Content-Type')).toBe('application/json');
    expect(call.credentials).toBe('same-origin');
    expect(call.headers.get('Authorization')).toBeNull();
    expect(call.body).toEqual({ a: 1 });
  });
  it('builds queries: arrays are comma-joined, empty values are dropped', async () => {
    const server = new FakeServer().on('GET', '/api/q', ok([])).install();
    await request('GET', '/api/q', { query: { status: ['active', 'trial'], q: '', page: 2, x: undefined, none: [] } });
    expect(server.calls[0]!.query.toString()).toBe('status=active%2Ctrial&page=2');
  });
  it('maps the server error envelope, including field details and the request id', async () => {
    new FakeServer().on('POST', '/api/x', fail(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [{ path: 'name', message: 'Name is required.' }])).install();
    const err = await request('POST', '/api/x', { body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'VALIDATION_ERROR', details: [{ path: 'name', message: 'Name is required.' }], requestId: 'req-test-1' });
  });
  it('turns a network failure into a friendly, retryable error', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const err = await request('GET', '/api/x').catch((e: unknown) => e as ApiError);
    expect(err).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    expect((err as ApiError).isNetwork).toBe(true);
    expect((err as ApiError).message).not.toMatch(/Failed to fetch/);
  });
  it('rejects a malformed success response instead of passing garbage on', async () => {
    vi.stubGlobal('fetch', async () => new Response('not json', { status: 200 }));
    await expect(request('GET', '/api/x')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
  it('a 401 notifies the session handler, except for auth endpoints that opt out', async () => {
    new FakeServer().on('GET', '/api/x', fail(401, 'UNAUTHENTICATED', 'Authentication required.')).install();
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    await request('GET', '/api/x').catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    await request('GET', '/api/x', { skipAuthRedirect: true }).catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('204 responses resolve without a body', async () => {
    new FakeServer().on('DELETE', '/api/x', { status: 204 }).install();
    await expect(request('DELETE', '/api/x')).resolves.toEqual({ data: undefined });
  });
});

describe('mapApiError', () => {
  const known = ['name', 'amountMinor', 'forBillingDate', 'currency'];
  it('puts field details on their fields and keeps unknown ones visible at form level', () => {
    const err = new ApiError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [
      { path: 'name', message: 'Name is required.' },
      { path: 'icon.value', message: 'Use a single emoji.' },
    ]);
    expect(mapApiError(err, known)).toEqual({ fields: { name: 'Name is required.' }, form: 'icon: Use a single emoji.' });
  });
  it('maps well-known codes to their field', () => {
    expect(mapApiError(new ApiError(409, 'DUPLICATE_PAYMENT_PERIOD', 'Already recorded.'), known).fields).toEqual({ forBillingDate: 'Already recorded.' });
    expect(mapApiError(new ApiError(409, 'CURRENCY_LOCKED', 'Locked.'), known).fields).toEqual({ currency: 'Locked.' });
  });
  it('anything else becomes a form-level message', () => {
    expect(mapApiError(new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong.'), known)).toEqual({ fields: {}, form: 'Something went wrong.' });
    expect(mapApiError(new Error('boom'), known).form).toMatch(/unexpected/i);
  });
});
