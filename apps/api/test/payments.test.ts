import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF, client, createCtx, createSub, insertSub, registerUser, resetDb, userIdOf, withFailingTrigger } from './helpers.js';

// Fake "now": 2030-01-15T10:00Z => 2030-01-15 for the default Asia/Kolkata user.
const ctx = createCtx();
const { app, pool, clock } = ctx;
let cookie: string;
let userId: string;
let api: ReturnType<typeof client>;
let subId: string; // monthly, anchor/next 2030-02-01

beforeEach(async () => {
  await resetDb(pool);
  clock.set('2030-01-15T10:00:00.000Z');
  const reg = await registerUser(app);
  cookie = reg.cookie;
  userId = userIdOf(reg.res);
  api = client(app, cookie);
  subId = (await createSub(app, cookie)).id;
});
afterAll(() => pool.end());

const pay = (id: string, body: unknown) => api.post(`/api/subscriptions/${id}/payments`, body);
const count = async (t: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n as number;
const subRow = async (id = subId) => (await pool.query('SELECT * FROM subscriptions WHERE id = $1', [id])).rows[0];
const fields = (res: request.Response) => (res.body.error.details as { path: string }[]).map((d) => d.path);

describe('POST /api/subscriptions/:id/payments', () => {
  it('records exactly what the user entered, labelled as user-entered, and changes nothing else', async () => {
    const before = await subRow();
    const res = await pay(subId, { amountMinor: 64900 });
    expect(res.status).toBe(201);
    expect(res.body.data.payment).toMatchObject({
      subscriptionId: subId, amountMinor: 64900, currency: 'INR', paidOn: '2030-01-15', status: 'paid',
      forBillingDate: null, note: null, source: 'user_entered',
    });
    expect(res.body.data.payment.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.data.nextBillingDateAdvanced).toBe(false);
    expect(res.body.data.subscription.nextBillingDate).toBe('2030-02-01');
    expect(await count('payments')).toBe(1);
    expect(await subRow()).toEqual(before); // no UPDATE was issued: not even updated_at moved
  });

  it('stores all optional fields, normalizing text and currency', async () => {
    const res = await pay(subId, {
      amountMinor: 1299, currency: ' usd ', paidOn: '2030-01-10', status: 'paid', forBillingDate: '2030-02-01', note: '  paid via card  ',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.payment).toMatchObject({ amountMinor: 1299, currency: 'USD', paidOn: '2030-01-10', forBillingDate: '2030-02-01', note: 'paid via card' });
  });

  describe('amount and currency', () => {
    it.each([1, 64900, 999_999_999_999, 1_000_000_000_000])('round-trips amount %i exactly', async (amountMinor) => {
      const res = await pay(subId, { amountMinor });
      expect(res.status).toBe(201);
      expect(res.body.data.payment.amountMinor).toBe(amountMinor);
    });
    it.each([[0], [-1], [1.5], ['649'], [null], [true], [1_000_000_000_001], [undefined]])('rejects amount %j', async (amountMinor) => {
      const res = await pay(subId, { amountMinor });
      expect(res.status).toBe(422);
      expect(fields(res)).toContain('amountMinor');
    });
    it('defaults the currency to the subscription’s; a different currency is allowed and reported as entered', async () => {
      expect((await pay(subId, { amountMinor: 100 })).body.data.payment.currency).toBe('INR');
      const res = await pay(subId, { amountMinor: 799, currency: 'USD' });
      expect(res.status).toBe(201);
      expect(res.body.data.payment.currency).toBe('USD');
      expect(res.body.data.subscription.currency).toBe('INR'); // the subscription is untouched
    });
    it.each(['XXX', 'INRR', 'RS', 5, null, {}])('rejects currency %j', async (currency) => {
      const res = await pay(subId, { amountMinor: 100, currency });
      expect(res.status).toBe(422);
      expect(fields(res)).toContain('currency');
    });
  });

  describe('status', () => {
    it.each(['paid', 'failed', 'refunded'])('accepts %s', async (status) => {
      expect((await pay(subId, { amountMinor: 100, status })).body.data.payment.status).toBe(status);
    });
    it.each(['pending', 'PAID', '', 5, null])('rejects %j', async (status) => {
      expect((await pay(subId, { amountMinor: 100, status })).status).toBe(422);
    });
  });

  describe('paidOn boundaries', () => {
    it('today and the past are fine (including before the start date, which defaults to today); tomorrow is not', async () => {
      expect((await pay(subId, { amountMinor: 1, paidOn: '2030-01-15' })).status).toBe(201);
      expect((await pay(subId, { amountMinor: 1, paidOn: '2030-01-14' })).status).toBe(201);
      expect((await pay(subId, { amountMinor: 1, paidOn: '2029-06-01' })).status).toBe(201);
      expect((await pay(subId, { amountMinor: 1, paidOn: '1990-01-01' })).status).toBe(201);
      const future = await pay(subId, { amountMinor: 1, paidOn: '2030-01-16' });
      expect(future.status).toBe(422);
      expect(fields(future)).toContain('paidOn');
    });
    it('"today" is the user’s own calendar day (time zone aware)', async () => {
      clock.set('2030-01-15T20:00:00Z'); // 2030-01-16 in Kolkata, still 2030-01-15 in Los Angeles
      expect((await pay(subId, { amountMinor: 1, paidOn: '2030-01-16' })).status).toBe(201);
      expect((await pay(subId, { amountMinor: 1, paidOn: '2030-01-17' })).status).toBe(422);
      await pool.query("UPDATE user_preferences SET timezone = 'America/Los_Angeles' WHERE user_id = $1", [userId]);
      expect((await pay(subId, { amountMinor: 1, paidOn: '2030-01-16' })).status).toBe(422);
      expect((await pay(subId, { amountMinor: 1, paidOn: '2030-01-15' })).status).toBe(201);
    });
    it.each(['2030-02-30', '2030-1-1', '2030-01-01T00:00:00Z', '01/02/2030', '', 'today', 20300101, '1989-12-31', '2101-01-01'])('rejects date %j', async (paidOn) => {
      const res = await pay(subId, { amountMinor: 1, paidOn });
      expect(res.status).toBe(422);
      expect(fields(res)).toContain('paidOn');
    });
    it('defaults to the user’s today', async () => {
      clock.set('2030-01-15T20:00:00Z');
      expect((await pay(subId, { amountMinor: 1 })).body.data.payment.paidOn).toBe('2030-01-16');
    });
  });

  describe('note and unknown fields', () => {
    it('trims, treats blank as null, enforces 500 chars, control characters and card-like text', async () => {
      expect((await pay(subId, { amountMinor: 1, note: '   ' })).body.data.payment.note).toBeNull();
      expect((await pay(subId, { amountMinor: 1, note: 'x'.repeat(500) })).status).toBe(201);
      expect((await pay(subId, { amountMinor: 1, note: 'two\nlines' })).status).toBe(201);
      for (const note of ['x'.repeat(501), 'a\u0000b', 'card 4111 1111 1111 1111', 'cvv 123']) {
        const res = await pay(subId, { amountMinor: 1, note });
        expect(res.status, note).toBe(422);
        expect(fields(res)).toContain('note');
      }
    });
    it.each([
      ['userId', { userId: 'x' }], ['subscriptionId', { subscriptionId: 'x' }], ['id', { id: 'x' }], ['createdAt', { createdAt: 'x' }],
      ['source', { source: 'bank_verified' }], ['verified', { verified: true }], ['arbitrary', { foo: 1 }],
    ])('rejects unknown field %s', async (_n, extra) => {
      const res = await pay(subId, { amountMinor: 1, ...extra });
      expect(res.status).toBe(422);
      expect(await count('payments')).toBe(0);
    });
    it('rejects malformed JSON, non-object and missing bodies', async () => {
      const malformed = await request(app).post(`/api/subscriptions/${subId}/payments`).set(CSRF).set('Cookie', cookie).set('Content-Type', 'application/json').send('{"amountMinor": ');
      expect(malformed.status).toBe(400);
      expect((await pay(subId, [])).status).toBe(422);
      expect((await api.post(`/api/subscriptions/${subId}/payments`)).status).toBe(422);
    });
  });

  describe('forBillingDate follows the recurrence rules', () => {
    it('must be a date on the anchor schedule (not before the anchor, not off-day)', async () => {
      expect((await pay(subId, { amountMinor: 1, forBillingDate: '2030-02-01' })).status).toBe(201);
      expect((await pay(subId, { amountMinor: 1, forBillingDate: '2030-03-01' })).status).toBe(201); // paying ahead is recordable
      for (const forBillingDate of ['2030-02-02', '2030-01-01', '2029-12-01', '2030-03-31']) {
        const res = await pay(subId, { amountMinor: 1, forBillingDate });
        expect(res.status, forBillingDate).toBe(422);
        expect(fields(res)).toContain('forBillingDate');
      }
    });
    it('month-end: clamped dates are accepted on a 31st schedule, drifted ones are not', async () => {
      const m = await createSub(app, cookie, { anchorDate: '2030-01-31', startDate: '2030-01-15', nextBillingDate: '2030-02-28' });
      expect((await pay(m.id, { amountMinor: 1, forBillingDate: '2030-02-28' })).status).toBe(201);
      expect((await pay(m.id, { amountMinor: 1, forBillingDate: '2030-03-31' })).status).toBe(201);
      expect((await pay(m.id, { amountMinor: 1, forBillingDate: '2030-03-28' })).status).toBe(422);
    });
    it('quarterly and weekly schedules', async () => {
      const q = await createSub(app, cookie, { billingFrequency: 'quarterly', anchorDate: '2030-01-31', startDate: '2030-01-15', nextBillingDate: '2030-04-30' });
      expect((await pay(q.id, { amountMinor: 1, forBillingDate: '2030-04-30' })).status).toBe(201);
      expect((await pay(q.id, { amountMinor: 1, forBillingDate: '2030-02-28' })).status).toBe(422);
      const w = await createSub(app, cookie, { billingFrequency: 'weekly', anchorDate: '2030-01-10', nextBillingDate: '2030-01-17' });
      expect((await pay(w.id, { amountMinor: 1, forBillingDate: '2030-01-24' })).status).toBe(201);
      expect((await pay(w.id, { amountMinor: 1, forBillingDate: '2030-01-25' })).status).toBe(422);
    });
  });

  it('records payments for non-active subscriptions too (history), but they cannot advance', async () => {
    for (const status of ['paused', 'cancelled', 'archived'] as const) {
      const id = await insertSub(pool, userId, {
        status, ...(status === 'cancelled' ? { cancelled_on: '2030-01-10' } : {}), ...(status === 'archived' ? { status_before_archive: 'active' } : {}),
      });
      expect((await pay(id, { amountMinor: 100 })).status, status).toBe(201);
      const adv = await pay(id, { amountMinor: 100, forBillingDate: '2030-02-01', advanceNextBillingDate: true });
      expect(adv.status, status).toBe(422);
      expect(fields(adv)).toContain('advanceNextBillingDate');
    }
  });

  it('requires authentication and the CSRF header', async () => {
    expect((await client(app).post(`/api/subscriptions/${subId}/payments`, { amountMinor: 1 })).status).toBe(401);
    expect((await request(app).post(`/api/subscriptions/${subId}/payments`).set('Cookie', cookie).send({ amountMinor: 1 })).status).toBe(403);
    expect(await count('payments')).toBe(0);
  });
});

describe('duplicate-per-period guard', () => {
  it('rejects a second PAID payment for the same renewal, regardless of amount or date', async () => {
    const first = await pay(subId, { amountMinor: 64900, forBillingDate: '2030-02-01', paidOn: '2030-01-14' });
    expect(first.status).toBe(201);
    const dup = await pay(subId, { amountMinor: 12345, forBillingDate: '2030-02-01', paidOn: '2030-01-10' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_PAYMENT_PERIOD');
    expect(dup.body.error.message).toContain('2030-02-01');
    expect(await count('payments')).toBe(1);
    expect((await pool.query('SELECT amount_minor FROM payments')).rows[0].amount_minor).toBe(64900); // original intact
  });

  it('does NOT reject legitimate separate payments just because amount and date match', async () => {
    expect((await pay(subId, { amountMinor: 64900, paidOn: '2030-01-10' })).status).toBe(201);
    expect((await pay(subId, { amountMinor: 64900, paidOn: '2030-01-10' })).status).toBe(201); // same amount, same day, no period named
    expect((await pay(subId, { amountMinor: 64900, forBillingDate: '2030-02-01', paidOn: '2030-01-10' })).status).toBe(201);
    expect((await pay(subId, { amountMinor: 64900, forBillingDate: '2030-03-01', paidOn: '2030-01-10' })).status).toBe(201); // same amount, different period
    expect(await count('payments')).toBe(4);
  });

  it('only PAID payments are guarded: failed attempts, retries and refunds for the same period are fine', async () => {
    const f = (status: string) => pay(subId, { amountMinor: 100, forBillingDate: '2030-02-01', status });
    expect((await f('failed')).status).toBe(201);
    expect((await f('failed')).status).toBe(201);
    expect((await f('paid')).status).toBe(201);
    expect((await f('refunded')).status).toBe(201);
    expect((await f('refunded')).status).toBe(201);
    expect((await f('paid')).status).toBe(409);
    expect(await count('payments')).toBe(5);
  });

  it('the same period on a different subscription (or user) is independent', async () => {
    const other = await createSub(app, cookie, { name: 'Other' });
    expect((await pay(subId, { amountMinor: 1, forBillingDate: '2030-02-01' })).status).toBe(201);
    expect((await pay(other.id, { amountMinor: 1, forBillingDate: '2030-02-01' })).status).toBe(201);
    const b = await registerUser(app);
    const bSub = (await createSub(app, b.cookie)).id;
    expect((await client(app, b.cookie).post(`/api/subscriptions/${bSub}/payments`, { amountMinor: 1, forBillingDate: '2030-02-01' })).status).toBe(201);
  });

  it('after deleting the paid record the period can be recorded again', async () => {
    const first = await pay(subId, { amountMinor: 100, forBillingDate: '2030-02-01' });
    await api.del(`/api/subscriptions/${subId}/payments/${first.body.data.payment.id}`).expect(204);
    expect((await pay(subId, { amountMinor: 100, forBillingDate: '2030-02-01' })).status).toBe(201);
  });

  it('concurrent identical requests: exactly one is recorded, the rest get 409', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => pay(subId, { amountMinor: 64900, forBillingDate: '2030-02-01' })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await count('payments')).toBe(1);
  });

  it('concurrent advancing requests for the same renewal cannot double-advance the date', async () => {
    const results = await Promise.all([1, 2, 3].map(() => pay(subId, { amountMinor: 64900, forBillingDate: '2030-02-01', advanceNextBillingDate: true })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect((await subRow()).next_billing_date).toBe('2030-03-01'); // advanced exactly once
    expect(await count('payments')).toBe(1);
  });
});

describe('advancing the next billing date', () => {
  const advance = (id: string, forBillingDate: string, extra: object = {}) =>
    pay(id, { amountMinor: 64900, forBillingDate, advanceNextBillingDate: true, ...extra });

  it('moves to the next occurrence on the SAME anchor schedule and reports it', async () => {
    const res = await advance(subId, '2030-02-01');
    expect(res.status).toBe(201);
    expect(res.body.data.nextBillingDateAdvanced).toBe(true);
    expect(res.body.data.subscription).toMatchObject({ nextBillingDate: '2030-03-01', effectiveNextBillingDate: '2030-03-01', anchorDate: '2030-02-01' });
    const row = await subRow();
    expect(row.next_billing_date).toBe('2030-03-01');
    expect(row.anchor_date).toBe('2030-02-01'); // anchor untouched
    expect(await count('payments')).toBe(1); // exactly the one the user recorded, nothing fabricated
  });

  it('does not advance unless asked (default and explicit false)', async () => {
    await pay(subId, { amountMinor: 1, forBillingDate: '2030-02-01' }).expect(201);
    await pay(subId, { amountMinor: 1, forBillingDate: '2030-03-01', advanceNextBillingDate: false }).expect(201);
    expect((await subRow()).next_billing_date).toBe('2030-02-01');
  });

  it('month-end: a 31st anchor goes Feb 28 -> Mar 31 -> Apr 30 -> May 31 (no drift to the 28th)', async () => {
    const m = await createSub(app, cookie, { anchorDate: '2030-01-31', startDate: '2030-01-15', nextBillingDate: '2030-02-28' });
    const steps: [string, string][] = [['2030-02-28', '2030-03-31'], ['2030-03-31', '2030-04-30'], ['2030-04-30', '2030-05-31']];
    for (const [paid, expectedNext] of steps) {
      const res = await advance(m.id, paid);
      expect(res.status, paid).toBe(201);
      expect(res.body.data.subscription.nextBillingDate).toBe(expectedNext);
      expect(res.body.data.subscription.anchorDate).toBe('2030-01-31');
    }
  });

  it('yearly with a leap-day anchor: Feb 28 (common year) -> Feb 29 (leap year)', async () => {
    const y = await createSub(app, cookie, { billingFrequency: 'yearly', anchorDate: '2028-02-29', startDate: '2028-02-29', nextBillingDate: '2031-02-28' });
    expect((await advance(y.id, '2031-02-28')).body.data.subscription.nextBillingDate).toBe('2032-02-29');
  });

  it('quarterly and weekly', async () => {
    const q = await createSub(app, cookie, { billingFrequency: 'quarterly', anchorDate: '2030-01-31', startDate: '2030-01-15', nextBillingDate: '2030-04-30' });
    expect((await advance(q.id, '2030-04-30')).body.data.subscription.nextBillingDate).toBe('2030-07-31');
    const w = await createSub(app, cookie, { billingFrequency: 'weekly', anchorDate: '2030-01-10', nextBillingDate: '2030-01-17' });
    expect((await advance(w.id, '2030-01-17')).body.data.subscription.nextBillingDate).toBe('2030-01-24');
  });

  it('is never in the past: paying a stale renewal lands on the upcoming date', async () => {
    const stale = await insertSub(pool, userId, { next_billing_date: '2030-01-05', anchor_date: '2030-01-05', start_date: '2029-12-01' });
    clock.set('2030-01-15T10:00:00Z');
    const res = await advance(stale, '2030-01-05');
    expect(res.body.data.subscription.nextBillingDate).toBe('2030-02-05');
  });

  it('never moves backwards: paying an older renewal while the date is already ahead changes nothing', async () => {
    const ahead = await createSub(app, cookie, { anchorDate: '2030-02-01', nextBillingDate: '2030-03-01' });
    const res = await advance(ahead.id, '2030-02-01');
    expect(res.status).toBe(201);
    expect(res.body.data.nextBillingDateAdvanced).toBe(false);
    expect(res.body.data.subscription.nextBillingDate).toBe('2030-03-01');
    expect(await count('payments')).toBe(1);
  });

  it('cannot skip a renewal by paying ahead', async () => {
    const res = await advance(subId, '2030-03-01');
    expect(res.status).toBe(422);
    expect(fields(res)).toContain('forBillingDate');
    expect(await count('payments')).toBe(0);
    expect((await subRow()).next_billing_date).toBe('2030-02-01');
  });

  it.each([
    ['without forBillingDate', { amountMinor: 1, advanceNextBillingDate: true }, 'forBillingDate'],
    ['with an off-schedule date', { amountMinor: 1, forBillingDate: '2030-02-02', advanceNextBillingDate: true }, 'forBillingDate'],
    ['for a failed payment', { amountMinor: 1, forBillingDate: '2030-02-01', status: 'failed', advanceNextBillingDate: true }, 'advanceNextBillingDate'],
    ['for a refunded payment', { amountMinor: 1, forBillingDate: '2030-02-01', status: 'refunded', advanceNextBillingDate: true }, 'advanceNextBillingDate'],
  ])('rejects advancing %s, recording nothing', async (_n, body, path) => {
    const res = await pay(subId, body);
    expect(res.status).toBe(422);
    expect(fields(res)).toContain(path);
    expect(await count('payments')).toBe(0);
    expect((await subRow()).next_billing_date).toBe('2030-02-01');
  });

  it('a trial cannot be advanced (it is never auto-converted)', async () => {
    const t = await insertSub(pool, userId, { status: 'trial', trial_end_date: '2030-02-01' });
    const res = await advance(t, '2030-02-01');
    expect(res.status).toBe(422);
    expect((await pay(t, { amountMinor: 1 })).status).toBe(201); // but the payment itself may be recorded
  });

  it('a duplicate period fails the whole request: the date is not advanced', async () => {
    await pay(subId, { amountMinor: 1, forBillingDate: '2030-02-01' }).expect(201);
    const res = await advance(subId, '2030-02-01');
    expect(res.status).toBe(409);
    expect((await subRow()).next_billing_date).toBe('2030-02-01');
    expect(await count('payments')).toBe(1);
  });
});

describe('transactions roll back completely', () => {
  it('a failure while advancing the billing date also removes the just-inserted payment', async () => {
    await withFailingTrigger(pool, 'subscriptions', 'UPDATE', async () => {
      const res = await pay(subId, { amountMinor: 64900, forBillingDate: '2030-02-01', advanceNextBillingDate: true });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toMatch(/simulated|trigger|payments/i); // internals are not leaked
    });
    expect(await count('payments')).toBe(0);
    expect((await subRow()).next_billing_date).toBe('2030-02-01');
  });

  it('a failing payment insert leaves the subscription untouched', async () => {
    await withFailingTrigger(pool, 'payments', 'INSERT', async () => {
      const res = await pay(subId, { amountMinor: 64900, forBillingDate: '2030-02-01', advanceNextBillingDate: true });
      expect(res.status).toBe(500);
    });
    expect(await count('payments')).toBe(0);
    expect((await subRow()).next_billing_date).toBe('2030-02-01');
  });

  it('after a failed request the system still works (no stuck locks or half state)', async () => {
    await withFailingTrigger(pool, 'subscriptions', 'UPDATE', () => pay(subId, { amountMinor: 1, forBillingDate: '2030-02-01', advanceNextBillingDate: true }));
    const ok = await pay(subId, { amountMinor: 64900, forBillingDate: '2030-02-01', advanceNextBillingDate: true });
    expect(ok.status).toBe(201);
    expect(ok.body.data.subscription.nextBillingDate).toBe('2030-03-01');
  });

  it('a failing delete leaves the payment in place and reports a safe error', async () => {
    const p = await pay(subId, { amountMinor: 1 });
    await withFailingTrigger(pool, 'payments', 'DELETE', async () => {
      const res = await api.del(`/api/subscriptions/${subId}/payments/${p.body.data.payment.id}`);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });
    expect(await count('payments')).toBe(1);
  });
});

describe('GET /api/subscriptions/:id/payments', () => {
  it('is empty for a new subscription', async () => {
    expect((await api.get(`/api/subscriptions/${subId}/payments`)).body).toEqual({ data: [], meta: { page: 1, pageSize: 25, total: 0 } });
  });

  it('orders by paid date desc, then newest-recorded first, then id (deterministic)', async () => {
    const mk = async (note: string, paidOn: string) => (await pay(subId, { amountMinor: 100, paidOn, note })).body.data.payment.id as string;
    await mk('old', '2030-01-01');
    await mk('newest', '2030-01-14');
    await mk('tie-first', '2030-01-10');
    await mk('tie-second', '2030-01-10');
    await mk('mid', '2030-01-05');
    const res = await api.get(`/api/subscriptions/${subId}/payments`);
    expect((res.body.data as { note: string }[]).map((p) => p.note)).toEqual(['newest', 'tie-second', 'tie-first', 'mid', 'old']);
    const again = await api.get(`/api/subscriptions/${subId}/payments`);
    expect(again.body.data).toEqual(res.body.data);
  });

  it('paginates without skipping or repeating, and reports the total', async () => {
    await pool.query(
      `INSERT INTO payments (user_id, subscription_id, amount_minor, currency, paid_on)
       SELECT $1, $2, 100 + g, 'INR', DATE '2029-01-01' + g FROM generate_series(1, 30) g`,
      [userId, subId],
    );
    const seen: string[] = [];
    for (let page = 1; page <= 5; page++) {
      const res = await api.get(`/api/subscriptions/${subId}/payments?pageSize=7&page=${page}`);
      expect(res.body.meta).toEqual({ page, pageSize: 7, total: 30 });
      seen.push(...(res.body.data as { id: string }[]).map((p) => p.id));
    }
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    expect((await api.get(`/api/subscriptions/${subId}/payments?page=9`)).body).toMatchObject({ data: [], meta: { total: 30 } });
  });

  it.each(['page=0', 'page=-1', 'page=x', 'pageSize=0', 'pageSize=101', 'pageSize=1.5', 'userId=1', 'foo=bar', 'page=1&page=2'])('rejects %s', async (qs) => {
    expect((await api.get(`/api/subscriptions/${subId}/payments?${qs}`)).status).toBe(422);
  });

  it('only returns this subscription’s payments', async () => {
    const other = await createSub(app, cookie, { name: 'Other' });
    await pay(subId, { amountMinor: 111 });
    await pay(other.id, { amountMinor: 222 });
    const res = await api.get(`/api/subscriptions/${subId}/payments`);
    expect((res.body.data as { amountMinor: number }[]).map((p) => p.amountMinor)).toEqual([111]);
  });
});

describe('DELETE /api/subscriptions/:id/payments/:paymentId', () => {
  it('removes only that payment; the next billing date is not reverted', async () => {
    const a = await pay(subId, { amountMinor: 1, forBillingDate: '2030-02-01', advanceNextBillingDate: true });
    const b = await pay(subId, { amountMinor: 2 });
    const res = await api.del(`/api/subscriptions/${subId}/payments/${a.body.data.payment.id}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(await count('payments')).toBe(1);
    expect((await pool.query('SELECT id FROM payments')).rows[0].id).toBe(b.body.data.payment.id);
    expect((await subRow()).next_billing_date).toBe('2030-03-01'); // schedule edits are the subscription's job
  });
  it('404s unknown, repeated and malformed ids, and a payment addressed through the wrong subscription', async () => {
    const other = await createSub(app, cookie, { name: 'Other' });
    const p = await pay(subId, { amountMinor: 1 });
    const pid = p.body.data.payment.id as string;
    expect((await api.del(`/api/subscriptions/${other.id}/payments/${pid}`)).status).toBe(404); // wrong parent
    expect(await count('payments')).toBe(1);
    expect((await api.del(`/api/subscriptions/${subId}/payments/00000000-0000-0000-0000-000000000000`)).status).toBe(404);
    expect((await api.del(`/api/subscriptions/${subId}/payments/nope`)).status).toBe(404);
    expect((await api.del(`/api/subscriptions/nope/payments/${pid}`)).status).toBe(404);
    await api.del(`/api/subscriptions/${subId}/payments/${pid}`).expect(204);
    expect((await api.del(`/api/subscriptions/${subId}/payments/${pid}`)).status).toBe(404);
  });
  it('requires CSRF and authentication', async () => {
    const pid = (await pay(subId, { amountMinor: 1 })).body.data.payment.id;
    expect((await request(app).delete(`/api/subscriptions/${subId}/payments/${pid}`).set('Cookie', cookie)).status).toBe(403);
    expect((await client(app).del(`/api/subscriptions/${subId}/payments/${pid}`)).status).toBe(401);
    expect(await count('payments')).toBe(1);
  });
  it('deleting a subscription removes its payments', async () => {
    await pay(subId, { amountMinor: 1 });
    await api.del(`/api/subscriptions/${subId}`).expect(204);
    expect(await count('payments')).toBe(0);
  });
});

describe('currency lock once payment history exists', () => {
  it('blocks changing the subscription currency while payments exist; unlocks when the last is deleted', async () => {
    const p = await pay(subId, { amountMinor: 100 });
    const blocked = await api.patch(`/api/subscriptions/${subId}`, { currency: 'USD' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CURRENCY_LOCKED');
    expect((await api.patch(`/api/subscriptions/${subId}`, { currency: 'INR', name: 'same currency is fine' })).status).toBe(200);
    await api.del(`/api/subscriptions/${subId}/payments/${p.body.data.payment.id}`).expect(204);
    expect((await api.patch(`/api/subscriptions/${subId}`, { currency: 'USD' })).status).toBe(200);
  });
  it('a payment in another currency also locks it', async () => {
    await pay(subId, { amountMinor: 100, currency: 'USD' });
    expect((await api.patch(`/api/subscriptions/${subId}`, { currency: 'EUR' })).status).toBe(409);
  });
});

describe('ownership isolation (payments)', () => {
  let b: ReturnType<typeof client>;
  let paymentId: string;
  beforeEach(async () => {
    b = client(app, (await registerUser(app)).cookie);
    paymentId = (await pay(subId, { amountMinor: 64900, forBillingDate: '2030-02-01' })).body.data.payment.id;
  });
  const NONEXISTENT = '00000000-0000-4000-8000-000000000000';

  it('B cannot record a payment on A’s subscription: indistinguishable from a missing one', async () => {
    const asB = await b.post(`/api/subscriptions/${subId}/payments`, { amountMinor: 1 });
    const missing = await b.post(`/api/subscriptions/${NONEXISTENT}/payments`, { amountMinor: 1 });
    expect(asB.status).toBe(404);
    expect(asB.body).toEqual(missing.body);
    expect(await count('payments')).toBe(1);
  });
  it('B cannot list A’s payments, and malformed ids look the same', async () => {
    const asB = await b.get(`/api/subscriptions/${subId}/payments`);
    expect(asB.status).toBe(404);
    expect(asB.body).toEqual((await b.get(`/api/subscriptions/${NONEXISTENT}/payments`)).body);
    expect(asB.body).toEqual((await b.get('/api/subscriptions/not-a-uuid/payments')).body);
  });
  it('B cannot delete A’s payment, directly or through B’s own subscription', async () => {
    const bSub = (await b.post('/api/subscriptions', { name: 'B', amountMinor: 1, billingFrequency: 'monthly', nextBillingDate: '2030-02-01' })).body.data.id;
    expect((await b.del(`/api/subscriptions/${subId}/payments/${paymentId}`)).status).toBe(404);
    expect((await b.del(`/api/subscriptions/${bSub}/payments/${paymentId}`)).status).toBe(404);
    expect(await count('payments')).toBe(1);
  });
  it('B’s advance attempt on A’s subscription cannot move A’s billing date', async () => {
    await b.post(`/api/subscriptions/${subId}/payments`, { amountMinor: 1, forBillingDate: '2030-02-01', advanceNextBillingDate: true }).expect(404);
    expect((await subRow()).next_billing_date).toBe('2030-02-01');
  });
});
