import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runSchedulerCycle } from '../src/scheduler/cycle.js';
import { client, createCtx, createSub, insertSub, loginCookie, registerUser, resetDb, setPrefs, userIdOf, T0 } from './helpers.js';

const ctx = createCtx();
const { app, pool, clock, env } = ctx;
let userId: string;
let email: string;
let cookie: string;
let api: ReturnType<typeof client>;

beforeEach(async () => {
  await resetDb(pool);
  clock.set(T0); // 2030-01-15T10:00Z = 2030-01-15 in Asia/Kolkata
  const reg = await registerUser(app);
  userId = userIdOf(reg.res);
  email = reg.email;
  cookie = reg.cookie;
  api = client(app, cookie);
});
afterAll(() => pool.end());

const get = (qs = '') => api.get(`/api/analytics/spending${qs ? `?${qs}` : ''}`);
const data = async (qs = '') => (await get(qs)).body.data;
const payAt = (subId: string, paidOn: string, amountMinor: number, extra: Record<string, unknown> = {}) =>
  pool.query(
    `INSERT INTO payments (user_id, subscription_id, amount_minor, currency, paid_on, status)
     VALUES ($1, $2, $3, COALESCE($4, (SELECT currency FROM subscriptions WHERE id = $2)), $5, COALESCE($6, 'paid'))`,
    [userId, subId, amountMinor, extra.currency ?? null, paidOn, extra.status ?? null],
  );
const bucketOf = (cur: { buckets: { start: string }[] }, start: string) => cur.buckets.find((b) => b.start === start) as { start: string; paidMinor: number; refundedMinor: number; netMinor: number; paymentCount: number };
const snapshot = async () => ({
  subs: (await pool.query('SELECT * FROM subscriptions ORDER BY id')).rows,
  payments: (await pool.query('SELECT * FROM payments ORDER BY id')).rows,
  reminders: (await pool.query('SELECT * FROM reminders ORDER BY id')).rows,
});

describe('structure: three kinds of numbers, never blended', () => {
  it('labels estimate, recorded and projection separately', async () => {
    const d = await data();
    expect(d).toMatchObject({
      timeZone: 'Asia/Kolkata', today: '2030-01-15',
      estimate: { kind: 'estimate', asOf: '2030-01-15', currencies: [] },
      recorded: { kind: 'recorded', bucket: 'month', currencies: [], recentPayments: [] },
      projection: { kind: 'projection' },
    });
    expect(d.projection.windows.map((w: { days: number }) => w.days)).toEqual([7, 30, 90]);
  });
});

describe('ESTIMATE: normalised recurring cost of active subscriptions at current prices', () => {
  it('is per currency, exact, and counts only ACTIVE subscriptions', async () => {
    await createSub(app, cookie, { name: 'W1', amountMinor: 100, billingFrequency: 'weekly' });
    await createSub(app, cookie, { name: 'W2', amountMinor: 100, billingFrequency: 'weekly' });
    await createSub(app, cookie, { name: 'W3', amountMinor: 100, billingFrequency: 'weekly' });
    await createSub(app, cookie, { name: 'Dropbox', amountMinor: 1200, currency: 'USD', billingFrequency: 'yearly', category: 'cloud_storage' });
    await createSub(app, cookie, { name: 'Trial', status: 'trial', trialEndDate: '2030-01-25', nextBillingDate: '2030-01-25', amountMinor: 9999 });
    const paused = await createSub(app, cookie, { name: 'Paused', amountMinor: 9999 });
    await api.post(`/api/subscriptions/${paused.id}/status`, { action: 'pause' }).expect(200);
    const cancelled = await createSub(app, cookie, { name: 'Cancelled', amountMinor: 9999 });
    await api.post(`/api/subscriptions/${cancelled.id}/status`, { action: 'cancel' }).expect(200);

    const { currencies } = (await data()).estimate;
    expect(currencies.map((c: { currency: string }) => c.currency)).toEqual(['INR', 'USD']);
    // 3 x 100/week = 3 x 100 x 52 / 12 = 1300 per month EXACTLY (not 3 x 433 = 1299)
    expect(currencies[0]).toMatchObject({ currency: 'INR', subscriptionCount: 3, monthlyEquivalentMinor: 1300, annualizedMinor: 15600 });
    expect(currencies[1]).toMatchObject({ currency: 'USD', subscriptionCount: 1, monthlyEquivalentMinor: 100, annualizedMinor: 1200 });
  });

  it('category breakdowns never combine currencies, and top subscriptions are limited and ordered', async () => {
    await createSub(app, cookie, { name: 'A', category: 'video', amountMinor: 3000 });
    await createSub(app, cookie, { name: 'B', category: 'music', amountMinor: 1000 });
    await createSub(app, cookie, { name: 'C', category: 'video', amountMinor: 99_000, currency: 'USD' });
    const { currencies } = (await data()).estimate;
    const inr = currencies.find((c: { currency: string }) => c.currency === 'INR');
    const usd = currencies.find((c: { currency: string }) => c.currency === 'USD');
    expect(inr.byCategory.map((c: { category: string }) => c.category)).toEqual(['video', 'music']);
    expect(inr.byCategory[0]).toMatchObject({ monthlyEquivalentMinor: 3000, percent: 75 });
    expect(usd.byCategory).toEqual([expect.objectContaining({ category: 'video', monthlyEquivalentMinor: 99_000, percent: 100 })]);
    expect(inr.top.map((t: { name: string }) => t.name)).toEqual(['A', 'B']); // the USD subscription is not in the INR list
  });

  it('a passed renewal date NEVER turns into a payment: months of scheduler cycles leave recorded spending empty', async () => {
    const s = await createSub(app, cookie, { nextBillingDate: '2030-02-01' });
    await runSchedulerCycle(env);
    for (const when of ['2030-02-05T10:00:00Z', '2030-04-01T10:00:00Z', '2030-09-01T10:00:00Z']) {
      clock.set(when);
      await runSchedulerCycle(env);
    }
    api = client(app, await loginCookie(app, email));
    const d = await data('from=2030-01-01');
    expect(d.estimate.currencies[0]).toMatchObject({ monthlyEquivalentMinor: 64900 }); // still estimated from the current price
    expect(d.recorded.currencies).toEqual([]); // ...but nothing was "paid"
    expect(d.recorded.recentPayments).toEqual([]);
    expect((await pool.query('SELECT count(*)::int n FROM payments')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT status FROM subscriptions WHERE id = $1', [s.id])).rows[0].status).toBe('active');
  });
});

describe('RECORDED: only payments the user entered', () => {
  it('sums paid minus refunded per currency and bucket; failed payments are counted but never added', async () => {
    const s = await createSub(app, cookie);
    await payAt(s.id, '2030-01-10', 64900);
    await payAt(s.id, '2030-01-12', 10000, { status: 'refunded' });
    await payAt(s.id, '2030-01-13', 99999, { status: 'failed' });
    await payAt(s.id, '2029-12-05', 20000);
    const rec = (await data()).recorded;
    expect(rec.currencies).toHaveLength(1);
    const inr = rec.currencies[0];
    expect(inr).toMatchObject({ currency: 'INR', paidMinor: 84900, refundedMinor: 10000, netMinor: 74900, paymentCount: 3, failedCount: 1 });
    expect(bucketOf(inr, '2030-01-01')).toEqual({ start: '2030-01-01', paidMinor: 64900, refundedMinor: 10000, netMinor: 54900, paymentCount: 2 });
    expect(bucketOf(inr, '2029-12-01')).toMatchObject({ netMinor: 20000, paymentCount: 1 });
  });

  it('currencies are never summed together: each has its own totals and buckets', async () => {
    const inr = await createSub(app, cookie, { name: 'In' });
    const usd = await createSub(app, cookie, { name: 'Out', currency: 'USD', amountMinor: 1000 });
    await payAt(inr.id, '2030-01-10', 64900);
    await payAt(usd.id, '2030-01-10', 1000);
    await payAt(inr.id, '2030-01-11', 799, { currency: 'USD' }); // a payment's own currency counts, whatever the subscription's
    const { currencies } = (await data()).recorded;
    expect(currencies.map((c: { currency: string; netMinor: number }) => [c.currency, c.netMinor])).toEqual([['INR', 64900], ['USD', 1799]]);
    expect(JSON.stringify(currencies)).not.toContain('65900'); // no INR+USD blend
  });

  it('INCLUDES payments of archived and cancelled subscriptions (spending history is not hidden by status)', async () => {
    const s = await createSub(app, cookie);
    await payAt(s.id, '2030-01-05', 5000);
    await api.post(`/api/subscriptions/${s.id}/status`, { action: 'cancel' }).expect(200);
    await api.post(`/api/subscriptions/${s.id}/status`, { action: 'archive' }).expect(200);
    expect((await data()).recorded.currencies[0].netMinor).toBe(5000);
  });

  describe('date boundaries (inclusive; payment dates carry no time zone)', () => {
    it('a payment on `from` and one on `to` count; the days just outside do not', async () => {
      const s = await createSub(app, cookie);
      await payAt(s.id, '2029-12-31', 1);
      await payAt(s.id, '2030-01-01', 10);
      await payAt(s.id, '2030-01-10', 100);
      await payAt(s.id, '2030-01-11', 1000);
      const rec = (await data('from=2030-01-01&to=2030-01-10')).recorded;
      expect(rec).toMatchObject({ from: '2030-01-01', to: '2030-01-10' });
      expect(rec.currencies[0]).toMatchObject({ paidMinor: 110, paymentCount: 2 });
    });
    it('month boundaries: Jan 31 and Feb 1 land in different buckets; leap-day Feb 29 is February', async () => {
      clock.set('2032-03-10T10:00:00Z');
      const fresh = await loginCookie(app, email);
      api = client(app, fresh);
      const s = await createSub(app, fresh, { nextBillingDate: '2032-03-20', startDate: '2032-01-01' });
      await payAt(s.id, '2032-01-31', 1);
      await payAt(s.id, '2032-02-01', 10);
      await payAt(s.id, '2032-02-29', 100);
      await payAt(s.id, '2032-03-01', 1000);
      const inr = (await data('from=2032-01-01&to=2032-03-10')).recorded.currencies[0];
      expect(inr.buckets.map((b: { start: string; paidMinor: number }) => [b.start, b.paidMinor])).toEqual([['2032-01-01', 1], ['2032-02-01', 110], ['2032-03-01', 1000]]);
    });
    it('weekly buckets start on MONDAY: Sunday belongs to the week that began the Monday before', async () => {
      const s = await createSub(app, cookie);
      await payAt(s.id, '2030-01-13', 1); // Sunday
      await payAt(s.id, '2030-01-14', 10); // Monday
      await payAt(s.id, '2030-01-15', 100); // Tuesday
      const rec = (await data('from=2030-01-07&to=2030-01-15&bucket=week')).recorded;
      expect(rec.bucket).toBe('week');
      expect(rec.currencies[0].buckets.map((b: { start: string; paidMinor: number }) => [b.start, b.paidMinor])).toEqual([['2030-01-07', 1], ['2030-01-14', 110]]);
    });
    it('a week bucket can span the year boundary (Mon 2030-12-30 .. Sun 2031-01-05)', async () => {
      clock.set('2031-01-10T10:00:00Z');
      const fresh = await loginCookie(app, email);
      api = client(app, fresh);
      const s = await createSub(app, fresh, { nextBillingDate: '2031-01-20', startDate: '2030-12-01' });
      await payAt(s.id, '2030-12-31', 5);
      await payAt(s.id, '2031-01-02', 50);
      const rec = (await data('from=2030-12-30&to=2031-01-10&bucket=week')).recorded;
      expect(rec.currencies[0].buckets.map((b: { start: string; paidMinor: number }) => [b.start, b.paidMinor])).toEqual([['2030-12-30', 55], ['2031-01-06', 0]]);
    });
    it('zero-activity buckets are explicit zeros, and the default window is the last 12 months to today', async () => {
      const s = await createSub(app, cookie);
      await payAt(s.id, '2029-06-10', 700);
      const rec = (await data()).recorded;
      expect(rec).toMatchObject({ from: '2029-02-01', to: '2030-01-15' });
      const inr = rec.currencies[0];
      expect(inr.buckets).toHaveLength(12);
      expect(inr.buckets[0].start).toBe('2029-02-01');
      expect(inr.buckets.at(-1).start).toBe('2030-01-01');
      expect(inr.buckets.filter((b: { paidMinor: number }) => b.paidMinor === 0)).toHaveLength(11);
      expect(bucketOf(inr, '2029-06-01').paidMinor).toBe(700);
    });
    it('`to` is clamped to today: no future buckets are invented', async () => {
      const s = await createSub(app, cookie);
      await payAt(s.id, '2030-01-10', 1);
      const rec = (await data('from=2029-12-01&to=2030-12-31')).recorded;
      expect(rec.to).toBe('2030-01-15');
      expect(rec.currencies[0].buckets.map((b: { start: string }) => b.start)).toEqual(['2029-12-01', '2030-01-01']);
    });
    it('"today" (the default end) is the owner’s own calendar day', async () => {
      const la = await registerUser(app);
      await setPrefs(pool, userIdOf(la.res), { timezone: 'America/Los_Angeles' });
      clock.set('2030-01-15T20:00:00Z'); // Jan 16 in Kolkata, Jan 15 in Los Angeles
      expect((await data()).recorded.to).toBe('2030-01-16');
      expect((await client(app, la.cookie).get('/api/analytics/spending')).body.data.recorded.to).toBe('2030-01-15');
    });
  });

  it('recent payments: newest first, limited to five, with the subscription name; only the user’s own', async () => {
    const a = await createSub(app, cookie, { name: 'Alpha' });
    const b = await registerUser(app);
    const theirs = await createSub(app, b.cookie, { name: 'TheirSecret' });
    for (let i = 1; i <= 7; i++) await payAt(a.id, `2030-01-0${i}`, i * 100);
    await pool.query("INSERT INTO payments (user_id, subscription_id, amount_minor, currency, paid_on) VALUES ($1,$2,5,'INR','2030-01-14')", [userIdOf(b.res), theirs.id]);
    const { recentPayments } = (await data()).recorded;
    expect(recentPayments).toHaveLength(5);
    expect(recentPayments.map((p: { paidOn: string }) => p.paidOn)).toEqual(['2030-01-07', '2030-01-06', '2030-01-05', '2030-01-04', '2030-01-03']);
    expect(recentPayments[0]).toMatchObject({ subscriptionName: 'Alpha', amountMinor: 700, currency: 'INR', status: 'paid' });
    expect(JSON.stringify(recentPayments)).not.toContain('TheirSecret');
  });
});

describe('PROJECTION: expected future renewals, not charges', () => {
  it('7/30/90-day windows (inclusive of the last day), per currency, with trial endings counted apart', async () => {
    await createSub(app, cookie, { name: 'In7', amountMinor: 100, nextBillingDate: '2030-01-22' }); // exactly day 7
    await createSub(app, cookie, { name: 'On8', amountMinor: 200, currency: 'USD', nextBillingDate: '2030-01-23' });
    await createSub(app, cookie, { name: 'Trial', status: 'trial', trialEndDate: '2030-01-16', nextBillingDate: '2030-01-16', amountMinor: 777 });
    const [w7, w30, w90] = (await data()).projection.windows;
    expect(w7).toMatchObject({ days: 7, to: '2030-01-22', trialEndCount: 1, currencies: [{ currency: 'INR', renewalCount: 1, amountMinor: 100 }] });
    expect(w30.currencies).toEqual([{ currency: 'INR', renewalCount: 1, amountMinor: 100 }, { currency: 'USD', renewalCount: 1, amountMinor: 200 }]);
    expect(w90.currencies).toEqual([{ currency: 'INR', renewalCount: 3, amountMinor: 300 }, { currency: 'USD', renewalCount: 3, amountMinor: 600 }]);
  });
  it('weekly subscriptions count every renewal in the window', async () => {
    await createSub(app, cookie, { billingFrequency: 'weekly', anchorDate: '2030-01-16', nextBillingDate: '2030-01-16', amountMinor: 50 });
    expect((await data()).projection.windows[1].currencies).toEqual([{ currency: 'INR', renewalCount: 5, amountMinor: 250 }]); // Jan 16, 23, 30, Feb 6, 13
  });
  it('matches the calendar for the same range (one definition of an occurrence)', async () => {
    await createSub(app, cookie, { anchorDate: '2030-01-31', nextBillingDate: '2030-01-31' });
    await createSub(app, cookie, { name: 'W', billingFrequency: 'weekly', anchorDate: '2030-01-17', nextBillingDate: '2030-01-17', amountMinor: 10 });
    const w30 = (await data()).projection.windows[1];
    const cal = (await api.get('/api/calendar/renewals?from=2030-01-15&to=2030-02-14')).body.meta.totals;
    expect(w30.currencies).toEqual(cal);
  });
});

describe('validation, isolation, read-only, auth', () => {
  it.each([
    'from=2030-02-01&to=2030-01-01', 'from=2030-02-30', 'bucket=day', 'bucket=Month', 'currency=INR', 'userId=x', 'from=2030-01-01&from=2030-01-02',
    'from=2030-12-01', // after today: nothing to show and no future buckets
  ])('rejects %s', async (qs) => {
    const res = await get(qs);
    expect(res.status, qs).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
  it('enforces the caps exactly', async () => {
    expect((await get('from=2029-01-15&to=2030-01-15&bucket=week')).status).toBe(200); // 366 days <= 372
    expect((await get('from=2029-01-01&to=2030-01-15&bucket=week')).status).toBe(422); // 380 days > 372
    expect((await get('from=2024-12-01&to=2030-01-15')).status).toBe(422); // > 1830 days of months
    expect((await get('from=2025-02-01&to=2030-01-15')).status).toBe(200); // 1810 days
  });

  it('never exposes another user’s subscriptions, payments or totals', async () => {
    const mine = await createSub(app, cookie, { name: 'Mine' });
    await payAt(mine.id, '2030-01-10', 100);
    const b = await registerUser(app);
    const theirs = await createSub(app, b.cookie, { name: 'BobsSecret', amountMinor: 55555, currency: 'USD' });
    await pool.query("INSERT INTO payments (user_id, subscription_id, amount_minor, currency, paid_on) VALUES ($1,$2,55555,'USD','2030-01-10')", [userIdOf(b.res), theirs.id]);
    const text = JSON.stringify((await client(app, cookie).get('/api/analytics/spending')).body);
    expect(text).not.toContain('BobsSecret');
    expect(text).not.toContain('USD');
    expect(text).not.toContain('55555');
  });
  it('is read-only', async () => {
    const s = await createSub(app, cookie);
    await payAt(s.id, '2030-01-10', 100);
    await insertSub(pool, userId, { name: 'Stale', next_billing_date: '2030-01-05', anchor_date: '2030-01-05', start_date: '2029-12-01' });
    const before = await snapshot();
    for (const qs of ['', 'bucket=week&from=2029-12-01', 'from=2029-06-01&to=2029-12-31']) await get(qs).expect(200);
    expect(await snapshot()).toEqual(before);
  });
  it('requires a session', async () => {
    expect((await client(app).get('/api/analytics/spending')).status).toBe(401);
  });
});
