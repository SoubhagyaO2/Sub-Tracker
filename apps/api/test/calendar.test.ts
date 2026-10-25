import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, createCtx, createSub, insertSub, registerUser, resetDb, setPrefs, userIdOf, loginCookie, T0 } from './helpers.js';

const ctx = createCtx();
const { app, pool, clock } = ctx;
let userId: string;
let email: string;
let api: ReturnType<typeof client>;
let cookie: string;

beforeEach(async () => {
  await resetDb(pool);
  clock.set(T0); // 2030-01-15T10:00Z: 2030-01-15 in Asia/Kolkata
  const reg = await registerUser(app);
  userId = userIdOf(reg.res);
  email = reg.email;
  cookie = reg.cookie;
  api = client(app, cookie);
});
afterAll(() => pool.end());

const cal = (qs = '') => api.get(`/api/calendar/renewals${qs ? `?${qs}` : ''}`);
const days = (res: { body: { data: { date: string; kind: string }[] } }) => res.body.data.map((o) => `${o.date}:${o.kind}`);
const snapshot = async () => ({
  subs: (await pool.query('SELECT * FROM subscriptions ORDER BY id')).rows,
  payments: (await pool.query('SELECT * FROM payments ORDER BY id')).rows,
  reminders: (await pool.query('SELECT * FROM reminders ORDER BY id')).rows,
});

describe('GET /api/calendar/renewals', () => {
  it('defaults to the next 30 days from today in the owner’s zone, labelled as a projection', async () => {
    await createSub(app, cookie, { name: 'Netflix', nextBillingDate: '2030-01-20' });
    const res = await cal();
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ from: '2030-01-15', to: '2030-02-13', today: '2030-01-15', timeZone: 'Asia/Kolkata', kind: 'projection', truncated: false, total: 1, trialEndCount: 0 });
    expect(res.body.data).toEqual([
      expect.objectContaining({ date: '2030-01-20', kind: 'renewal', name: 'Netflix', amountMinor: 64900, currency: 'INR', billingFrequency: 'monthly', status: 'active', subscriptionId: expect.any(String) }),
    ]);
  });

  describe('recurrence', () => {
    it.each([
      ['monthly on the 31st, across a short month', { anchorDate: '2030-01-31', nextBillingDate: '2030-01-31' }, '2030-01-15', '2030-05-31', ['2030-01-31', '2030-02-28', '2030-03-31', '2030-04-30', '2030-05-31']],
      ['quarterly', { billingFrequency: 'quarterly', anchorDate: '2030-01-31', nextBillingDate: '2030-01-31' }, '2030-01-15', '2030-12-31', ['2030-01-31', '2030-04-30', '2030-07-31', '2030-10-31']],
      ['yearly on a leap day (the leap year itself)', { billingFrequency: 'yearly', anchorDate: '2032-02-29', nextBillingDate: '2032-02-29', startDate: '2030-01-15' }, '2032-01-01', '2032-12-31', ['2032-02-29']],
      ['yearly on a leap day (the following common year)', { billingFrequency: 'yearly', anchorDate: '2032-02-29', nextBillingDate: '2032-02-29', startDate: '2030-01-15' }, '2033-01-01', '2033-12-31', ['2033-02-28']],
      ['yearly on a leap day (the next leap year)', { billingFrequency: 'yearly', anchorDate: '2032-02-29', nextBillingDate: '2032-02-29', startDate: '2030-01-15' }, '2036-01-01', '2036-12-31', ['2036-02-29']],
      ['weekly: several renewals in one month, over a year boundary', { billingFrequency: 'weekly', anchorDate: '2030-12-19', nextBillingDate: '2030-12-19' }, '2030-12-15', '2031-01-10', ['2030-12-19', '2030-12-26', '2031-01-02', '2031-01-09']],
    ])('%s', async (_n, over, from, to, expected) => {
      await createSub(app, cookie, over);
      // the calendar only looks forward, so move "today" to the start of the range (re-login: the session cannot span years)
      clock.set(`${from}T10:00:00Z`);
      api = client(app, await loginCookie(app, email));
      expect(days(await cal(`from=${from}&to=${to}`))).toEqual(expected.map((d) => `${d}:renewal`));
    });

    it('weekly subscriptions yield every occurrence (not just the next one)', async () => {
      await createSub(app, cookie, { billingFrequency: 'weekly', anchorDate: '2030-01-17', nextBillingDate: '2030-01-17' });
      expect((await cal('from=2030-01-15&to=2030-02-14')).body.data).toHaveLength(5);
    });
  });

  it('a stale saved date follows the schedule from today, WITHOUT writing it back', async () => {
    await insertSub(pool, userId, { name: 'Stale', next_billing_date: '2030-01-05', anchor_date: '2030-01-05', start_date: '2029-12-01' });
    const before = await snapshot();
    expect(days(await cal('to=2030-03-31'))).toEqual(['2030-02-05:renewal', '2030-03-05:renewal']);
    expect(await snapshot()).toEqual(before);
  });

  it('a renewal that was paid ahead (date advanced past it) is not shown again', async () => {
    const s = await createSub(app, cookie, { nextBillingDate: '2030-02-01' });
    await api.post(`/api/subscriptions/${s.id}/payments`, { amountMinor: 64900, forBillingDate: '2030-02-01', advanceNextBillingDate: true }).expect(201);
    expect(days(await cal('to=2030-03-31'))).toEqual(['2030-03-01:renewal']);
  });

  describe('status semantics', () => {
    it('active renews; trial shows its end; paused, cancelled and archived never appear as renewals', async () => {
      const active = await createSub(app, cookie, { name: 'Active', nextBillingDate: '2030-01-20' });
      await createSub(app, cookie, { name: 'Trial', status: 'trial', trialEndDate: '2030-01-25', nextBillingDate: '2030-01-25' });
      for (const [name, action] of [['Paused', 'pause'], ['Cancelled', 'cancel'], ['Archived', 'archive']] as const) {
        const s = await createSub(app, cookie, { name, nextBillingDate: '2030-01-22' });
        await api.post(`/api/subscriptions/${s.id}/status`, { action }).expect(200);
      }
      const res = await cal('to=2030-02-10');
      expect(res.body.data.map((o: { name: string; kind: string; date: string }) => `${o.name}:${o.kind}:${o.date}`)).toEqual(['Active:renewal:2030-01-20', 'Trial:trial_end:2030-01-25']);
      expect(res.body.meta).toMatchObject({ trialEndCount: 1, totals: [{ currency: 'INR', renewalCount: 1, amountMinor: 64900 }] });
      void active;
    });
    it('an ended trial shows nothing (SubCycle does not guess what happened next)', async () => {
      await insertSub(pool, userId, { name: 'OldTrial', status: 'trial', trial_end_date: '2030-01-10', next_billing_date: '2030-01-10', anchor_date: '2030-01-10', start_date: '2029-12-01' });
      expect((await cal('to=2030-03-01')).body.data).toEqual([]);
    });
  });

  it('totals are per currency and never mixed', async () => {
    await createSub(app, cookie, { amountMinor: 100, nextBillingDate: '2030-01-20' });
    await createSub(app, cookie, { amountMinor: 250, currency: 'USD', nextBillingDate: '2030-01-21' });
    await createSub(app, cookie, { amountMinor: 5, currency: 'USD', nextBillingDate: '2030-01-22' });
    expect((await cal('to=2030-01-31')).body.meta.totals).toEqual([
      { currency: 'INR', renewalCount: 1, amountMinor: 100 },
      { currency: 'USD', renewalCount: 2, amountMinor: 255 },
    ]);
  });

  describe('time zone', () => {
    it('"today" is the owner’s own calendar day: the same instant is a different range start for different users', async () => {
      await createSub(app, cookie, { nextBillingDate: '2030-01-15' }); // renews on Jan 15 (today at T0 in Kolkata)
      const la = await registerUser(app);
      await setPrefs(pool, userIdOf(la.res), { timezone: 'America/Los_Angeles' });
      await createSub(app, la.cookie, { nextBillingDate: '2030-01-15' });
      clock.set('2030-01-15T20:00:00Z'); // Jan 16 01:30 in Kolkata; Jan 15 12:00 in Los Angeles
      const kolkata = await cal('to=2030-01-20');
      const laRes = await client(app, la.cookie).get('/api/calendar/renewals?to=2030-01-20');
      expect(kolkata.body.meta).toMatchObject({ today: '2030-01-16', from: '2030-01-16' });
      expect(kolkata.body.data).toEqual([]); // Kolkata's Jan 15 renewal is already behind them
      expect(laRes.body.meta).toMatchObject({ today: '2030-01-15', timeZone: 'America/Los_Angeles' });
      expect(laRes.body.data.map((o: { date: string }) => o.date)).toEqual(['2030-01-15']);
    });
    it('an unusable stored zone falls back to UTC instead of failing the request', async () => {
      await setPrefs(pool, userId, { timezone: 'Mars/Olympus' });
      const res = await cal();
      expect(res.status).toBe(200);
      expect(res.body.meta.today).toBe('2030-01-15');
    });
  });

  describe('ranges and caps', () => {
    it('past dates are never returned: `from` is raised to today and says so', async () => {
      await createSub(app, cookie, { nextBillingDate: '2030-01-20' });
      const res = await cal('from=2029-06-01&to=2030-01-31');
      expect(res.status).toBe(200);
      expect(res.body.meta.from).toBe('2030-01-15');
      expect(res.body.data).toHaveLength(1);
      expect((await cal('from=2029-01-01&to=2029-12-31')).body).toMatchObject({ data: [], meta: { total: 0 } }); // an all-past range is simply empty
    });
    it('accepts exactly 366 days, rejects 367, and rejects reversed or malformed ranges', async () => {
      expect((await cal('from=2030-01-15&to=2031-01-15')).status).toBe(200); // 366 inclusive days
      expect((await cal('from=2030-01-15&to=2031-01-16')).status).toBe(422);
      expect((await cal('to=2031-06-01')).status).toBe(422); // an omitted `from` means today
      for (const qs of ['from=2030-02-01&to=2030-01-01', 'from=2030-02-30', 'to=tomorrow', 'from=2030-1-1', 'from=2101-01-01', 'from=2030-01-01&from=2030-01-02', 'userId=x', 'limit=5']) {
        const res = await cal(qs);
        expect(res.status, qs).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
    it('caps the number of occurrences at 1000 (earliest first) and says it was truncated, while totals still count everything', async () => {
      for (let i = 0; i < 22; i++) {
        await insertSub(pool, userId, { name: `W${String(i).padStart(2, '0')}`, billing_frequency: 'weekly', anchor_date: '2030-01-15', next_billing_date: '2030-01-15', start_date: '2030-01-01', amount_minor: 100 });
      }
      const res = await cal('from=2030-01-15&to=2031-01-15');
      expect(res.body.meta).toMatchObject({ total: 22 * 53, truncated: true });
      expect(res.body.data).toHaveLength(1000);
      expect(res.body.meta.totals).toEqual([{ currency: 'INR', renewalCount: 22 * 53, amountMinor: 22 * 53 * 100 }]);
      const dates = res.body.data.map((o: { date: string }) => o.date);
      expect([...dates].sort()).toEqual(dates); // the earliest 1000, in order
    });
  });

  it('is read-only: no calendar read changes any row of any table', async () => {
    await createSub(app, cookie);
    await createSub(app, cookie, { name: 'T', status: 'trial', trialEndDate: '2030-01-25', nextBillingDate: '2030-01-25' });
    await insertSub(pool, userId, { name: 'Stale', next_billing_date: '2030-01-05', anchor_date: '2030-01-05', start_date: '2029-12-01' });
    const before = await snapshot();
    for (const qs of ['', 'to=2030-12-31', 'from=2030-02-01&to=2030-02-28']) await cal(qs).expect(200);
    expect(await snapshot()).toEqual(before);
  });

  describe('ownership and authentication', () => {
    it('never shows another user’s subscriptions', async () => {
      await createSub(app, cookie, { name: 'AlicesPrivate', nextBillingDate: '2030-01-20' });
      const b = await registerUser(app);
      await createSub(app, b.cookie, { name: 'BobsOwn', nextBillingDate: '2030-01-21' });
      const asB = await client(app, b.cookie).get('/api/calendar/renewals?to=2030-02-10');
      expect(asB.body.data.map((o: { name: string }) => o.name)).toEqual(['BobsOwn']);
      expect(JSON.stringify(asB.body)).not.toContain('AlicesPrivate');
      expect(asB.body.meta.totals).toEqual([{ currency: 'INR', renewalCount: 1, amountMinor: 64900 }]);
    });
    it('requires a session', async () => {
      const res = await client(app).get('/api/calendar/renewals');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });
});
