import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { rollForwardStale } from '../src/services/recurrence.js';
import { client, createCtx, createSub, insertSub, registerUser, resetDb, userIdOf, type SubRowOverrides } from './helpers.js';

const ctx = createCtx();
const { app, pool, clock } = ctx;
let userId: string;
let cookie: string;
let api: ReturnType<typeof client>;

beforeEach(async () => {
  await resetDb(pool);
  clock.set('2030-01-15T10:00:00.000Z'); // today = 2030-01-15 for the default Asia/Kolkata user
  const reg = await registerUser(app);
  userId = userIdOf(reg.res);
  cookie = reg.cookie;
  api = client(app, cookie);
});
afterAll(() => pool.end());

const count = async (t: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n as number;
const row = async (id: string) => (await pool.query('SELECT * FROM subscriptions WHERE id = $1', [id])).rows[0];
const allRows = async () => (await pool.query('SELECT * FROM subscriptions ORDER BY id')).rows;
const stale = (o: SubRowOverrides = {}) => insertSub(pool, userId, { next_billing_date: '2030-01-05', anchor_date: '2030-01-05', start_date: '2029-12-01', ...o });

describe('reads are strictly read-only', () => {
  it('computes effectiveNextBillingDate on read without writing the stale stored date', async () => {
    const id = await stale();
    const before = await row(id);
    const res = await api.get(`/api/subscriptions/${id}`);
    expect(res.body.data).toMatchObject({ nextBillingDate: '2030-01-05', effectiveNextBillingDate: '2030-02-05', status: 'active' });
    expect(await row(id)).toEqual(before); // not even updated_at moved
  });

  it('no GET (detail, list, upcoming, payments, price history) mutates any row of any user', async () => {
    const mine = await stale({ name: 'mine' });
    await stale({ name: 'mine 2', next_billing_date: '2029-11-30', anchor_date: '2029-11-30' });
    const other = await registerUser(app);
    await insertSub(pool, userIdOf(other.res), { name: 'theirs', next_billing_date: '2029-12-31', anchor_date: '2029-12-31' });
    const before = await allRows();
    const paymentsBefore = await count('payments');

    for (const url of [
      `/api/subscriptions/${mine}`, '/api/subscriptions', '/api/subscriptions?renewsWithinDays=30&sort=nextRenewal',
      `/api/subscriptions/${mine}/upcoming`, `/api/subscriptions/${mine}/payments`, `/api/subscriptions/${mine}/price-history`,
    ]) {
      expect((await api.get(url)).status, url).toBe(200);
    }
    expect(await allRows()).toEqual(before);
    expect(await count('payments')).toBe(paymentsBefore);
  });

  it('effectiveNextBillingDate by status: active rolls, trial keeps, others are null', async () => {
    const ids = {
      active: await stale(),
      trial: await stale({ status: 'trial', trial_end_date: '2030-01-05' }),
      paused: await stale({ status: 'paused' }),
      cancelled: await stale({ status: 'cancelled', cancelled_on: '2030-01-04' }),
      archived: await stale({ status: 'archived', status_before_archive: 'active' }),
    };
    const eff = async (id: string) => (await api.get(`/api/subscriptions/${id}`)).body.data.effectiveNextBillingDate;
    expect(await eff(ids.active)).toBe('2030-02-05');
    expect(await eff(ids.trial)).toBe('2030-01-05');
    expect(await eff(ids.paused)).toBeNull();
    expect(await eff(ids.cancelled)).toBeNull();
    expect(await eff(ids.archived)).toBeNull();
  });

  it('"today" for the computation is the owner’s own calendar day', async () => {
    const auckland = await registerUser(app);
    await pool.query("UPDATE user_preferences SET timezone = 'Pacific/Auckland' WHERE user_id = $1", [userIdOf(auckland.res)]);
    const aId = await insertSub(pool, userIdOf(auckland.res), { next_billing_date: '2030-01-31', anchor_date: '2030-01-31', start_date: '2030-01-01' });
    const kId = await insertSub(pool, userId, { next_billing_date: '2030-01-31', anchor_date: '2030-01-31', start_date: '2030-01-01' });
    clock.set('2030-01-31T12:00:00Z'); // 2030-01-31 17:30 in Kolkata, 2030-02-01 01:00 in Auckland (UTC+13 in summer)
    // Sessions were created at T0 (15 days earlier), still valid (<14 days idle? no: touched at creation only) so log in again:
    const login = async (email: string) => {
      const r = await client(app).post('/api/auth/login', { email, password: 'Tr0ub4dor&3-horse' });
      return client(app, r.headers['set-cookie']![0]!.split(';')[0]);
    };
    const [k, a] = [await login((await pool.query('SELECT email FROM users WHERE id=$1', [userId])).rows[0].email), await login(auckland.email)];
    expect((await k.get(`/api/subscriptions/${kId}`)).body.data.effectiveNextBillingDate).toBe('2030-01-31');
    expect((await a.get(`/api/subscriptions/${aId}`)).body.data.effectiveNextBillingDate).toBe('2030-02-28'); // already Feb 1 there
  });
});

describe('rollForwardStale (the persisted roll-forward job)', () => {
  it('rolls active subscriptions forward along the anchor schedule and never creates payments', async () => {
    const monthly = await stale({ anchor_date: '2030-01-31', next_billing_date: '2030-01-31' });
    const weekly = await stale({ billing_frequency: 'weekly', anchor_date: '2030-01-03', next_billing_date: '2030-01-03' });
    const quarterly = await stale({ billing_frequency: 'quarterly', anchor_date: '2029-08-30', next_billing_date: '2029-11-30', start_date: '2029-08-30' });
    const yearly = await stale({ billing_frequency: 'yearly', anchor_date: '2028-02-29', next_billing_date: '2029-02-28', start_date: '2028-02-29' });
    clock.set('2030-03-15T10:00:00Z');

    expect(await rollForwardStale(pool, clock)).toBe(4);
    expect((await row(monthly)).next_billing_date).toBe('2030-03-31');
    expect((await row(weekly)).next_billing_date).toBe('2030-03-21');
    expect((await row(quarterly)).next_billing_date).toBe('2030-05-30'); // 2029-08-30, 11-30, 2030-02-28, 05-30
    expect((await row(yearly)).next_billing_date).toBe('2031-02-28'); // 2030-02-28 is behind; next is 2031-02-28 (2032 would be the leap day)
    expect(await count('payments')).toBe(0);
    expect(await count('subscription_price_history')).toBe(0);
  });

  it('keeps the anchor and all other fields; only next_billing_date changes', async () => {
    const id = await stale({ anchor_date: '2030-01-31', next_billing_date: '2030-01-31', name: 'Keep', amount_minor: 4242 });
    const before = await row(id);
    clock.set('2030-03-15T10:00:00Z');
    await rollForwardStale(pool, clock);
    const after = await row(id);
    const { next_billing_date: n1, updated_at: u1, ...rest1 } = before;
    const { next_billing_date: n2, updated_at: u2, ...rest2 } = after;
    expect(rest2).toEqual(rest1);
    expect(n1).toBe('2030-01-31');
    expect(n2).toBe('2030-03-31');
    void u1; void u2;
  });

  it('month-end never drifts across successive runs: Mar 31, Apr 30, May 31, then the leap-year Feb 29', async () => {
    const id = await stale({ anchor_date: '2030-01-31', next_billing_date: '2030-01-31' });
    for (const [now, expected] of [['2030-03-15', '2030-03-31'], ['2030-04-01', '2030-04-30'], ['2030-05-01', '2030-05-31'], ['2030-12-01', '2030-12-31'], ['2032-02-10', '2032-02-29']] as const) {
      clock.set(`${now}T10:00:00Z`);
      await rollForwardStale(pool, clock);
      expect((await row(id)).next_billing_date, now).toBe(expected);
      expect((await row(id)).anchor_date).toBe('2030-01-31');
    }
  });

  it('is idempotent and leaves current, future, and non-active rows alone', async () => {
    const current = await stale({ next_billing_date: '2030-01-15', anchor_date: '2030-01-15' }); // due today: not stale
    const future = await stale({ next_billing_date: '2030-02-01', anchor_date: '2030-02-01' });
    const trial = await stale({ status: 'trial', trial_end_date: '2030-01-05' });
    const paused = await stale({ status: 'paused' });
    const cancelled = await stale({ status: 'cancelled', cancelled_on: '2030-01-04' });
    const archived = await stale({ status: 'archived', status_before_archive: 'active' });
    const toRoll = await stale();
    const snapshot = Object.fromEntries(await Promise.all([current, future, trial, paused, cancelled, archived].map(async (id) => [id, await row(id)])));

    expect(await rollForwardStale(pool, clock)).toBe(1);
    expect((await row(toRoll)).next_billing_date).toBe('2030-02-05');
    for (const [id, before] of Object.entries(snapshot)) expect(await row(id), id).toEqual(before);
    expect(await rollForwardStale(pool, clock)).toBe(0); // second run: nothing to do
  });

  it('the boundary is exact: stale only once the owner’s calendar day has passed the stored date', async () => {
    const id = await stale({ next_billing_date: '2030-01-15', anchor_date: '2030-01-15' });
    clock.set('2030-01-15T18:29:59Z'); // 23:59:59 on the 15th in Kolkata
    expect(await rollForwardStale(pool, clock)).toBe(0);
    clock.set('2030-01-15T18:30:00Z'); // 00:00:00 on the 16th
    expect(await rollForwardStale(pool, clock)).toBe(1);
    expect((await row(id)).next_billing_date).toBe('2030-02-15');
  });

  it('uses each owner’s own time zone, including across a DST change', async () => {
    const la = await registerUser(app);
    await pool.query("UPDATE user_preferences SET timezone = 'America/Los_Angeles' WHERE user_id = $1", [userIdOf(la.res)]);
    const laSub = await insertSub(pool, userIdOf(la.res), { next_billing_date: '2030-03-10', anchor_date: '2030-03-10', start_date: '2030-01-01' });
    const utcUser = await registerUser(app);
    await pool.query("UPDATE user_preferences SET timezone = 'UTC' WHERE user_id = $1", [userIdOf(utcUser.res)]);
    const utcSub = await insertSub(pool, userIdOf(utcUser.res), { next_billing_date: '2030-03-10', anchor_date: '2030-03-10', start_date: '2030-01-01' });

    clock.set('2030-03-11T06:59:59Z'); // LA: 2030-03-10 23:59:59 PDT (just after spring-forward); UTC: already the 11th
    await rollForwardStale(pool, clock);
    expect((await row(laSub)).next_billing_date).toBe('2030-03-10'); // not stale yet for LA
    expect((await row(utcSub)).next_billing_date).toBe('2030-04-10'); // stale for the UTC user

    clock.set('2030-03-11T07:00:00Z'); // LA midnight
    await rollForwardStale(pool, clock);
    expect((await row(laSub)).next_billing_date).toBe('2030-04-10');
  });

  it('Pacific/Auckland (UTC+13) sees the next day before UTC does', async () => {
    const nz = await registerUser(app);
    await pool.query("UPDATE user_preferences SET timezone = 'Pacific/Auckland' WHERE user_id = $1", [userIdOf(nz.res)]);
    const id = await insertSub(pool, userIdOf(nz.res), { next_billing_date: '2030-01-31', anchor_date: '2030-01-31', start_date: '2030-01-01' });
    clock.set('2030-01-31T10:59:59Z'); // 23:59:59 NZDT on the 31st
    expect(await rollForwardStale(pool, clock)).toBe(0);
    clock.set('2030-01-31T11:00:00Z'); // 00:00:00 on Feb 1 in Auckland, still Jan 31 in UTC
    expect(await rollForwardStale(pool, clock)).toBe(1);
    expect((await row(id)).next_billing_date).toBe('2030-02-28');
  });

  it('can be restricted to one user and never touches another user’s subscriptions', async () => {
    const mine = await stale();
    const other = await registerUser(app);
    const theirs = await insertSub(pool, userIdOf(other.res), { next_billing_date: '2030-01-05', anchor_date: '2030-01-05', start_date: '2029-12-01' });
    const theirsBefore = await row(theirs);
    expect(await rollForwardStale(pool, clock, { userId })).toBe(1);
    expect((await row(mine)).next_billing_date).toBe('2030-02-05');
    expect(await row(theirs)).toEqual(theirsBefore);
    expect(await rollForwardStale(pool, clock)).toBe(1); // now the global run picks up the other user's row
    expect((await row(theirs)).next_billing_date).toBe('2030-02-05');
  });

  it('an unusable stored time zone for one user does not stop everyone else', async () => {
    const bad = await registerUser(app);
    await pool.query("UPDATE user_preferences SET timezone = 'Mars/Olympus' WHERE user_id = $1", [userIdOf(bad.res)]);
    const badSub = await insertSub(pool, userIdOf(bad.res), { next_billing_date: '2030-01-05', anchor_date: '2030-01-05', start_date: '2029-12-01' });
    const ok = await stale();
    expect(await rollForwardStale(pool, clock)).toBe(1);
    expect((await row(ok)).next_billing_date).toBe('2030-02-05');
    expect((await row(badSub)).next_billing_date).toBe('2030-01-05');
  });

  it('processes more rows than one batch (keyset paging terminates and covers everyone)', async () => {
    await pool.query(
      `INSERT INTO subscriptions (user_id, name, amount_minor, billing_frequency, anchor_date, next_billing_date, start_date)
       SELECT $1, 'Bulk ' || g, 100, 'monthly', '2030-01-05', '2030-01-05', '2029-12-01' FROM generate_series(1, 1200) g`,
      [userId],
    );
    expect(await rollForwardStale(pool, clock)).toBe(1200);
    expect((await pool.query("SELECT count(*)::int n FROM subscriptions WHERE next_billing_date = '2030-02-05'")).rows[0].n).toBe(1200);
    expect(await rollForwardStale(pool, clock)).toBe(0);
  });

  it('a concurrent user edit wins: a row that changed since it was read is not overwritten', async () => {
    const id = await stale();
    // The user edits the date (to a future date) before the job runs: the job must see a non-stale row and skip it.
    await api.patch(`/api/subscriptions/${id}`, { nextBillingDate: '2030-06-20' }).expect(200);
    expect(await rollForwardStale(pool, clock)).toBe(0);
    expect((await row(id)).next_billing_date).toBe('2030-06-20');
    expect((await row(id)).anchor_date).toBe('2030-06-20'); // the user's edit also reset the anchor, which the job respected
  });
});

describe('GET /api/subscriptions/:id/upcoming (read-only projection)', () => {
  const upcoming = (id: string, qs = '') => api.get(`/api/subscriptions/${id}/upcoming${qs ? `?${qs}` : ''}`);
  const dates = (res: { body: { data: { date: string }[] } }) => res.body.data.map((o) => o.date);

  it('lists the next occurrences at the current price, labelled as a projection', async () => {
    const { id } = await createSub(app, cookie, { amountMinor: 64900, anchorDate: '2030-01-31', startDate: '2030-01-15', nextBillingDate: '2030-02-28' });
    const res = await upcoming(id, 'count=5');
    expect(res.status).toBe(200);
    expect(dates(res)).toEqual(['2030-02-28', '2030-03-31', '2030-04-30', '2030-05-31', '2030-06-30']);
    expect(res.body.data[0]).toEqual({ date: '2030-02-28', amountMinor: 64900, currency: 'INR' });
    expect(res.body.meta.kind).toBe('projection');
  });

  it('every frequency, including leap-year and year-boundary cases', async () => {
    const w = await createSub(app, cookie, { billingFrequency: 'weekly', anchorDate: '2030-12-19', startDate: '2030-01-15', nextBillingDate: '2030-12-19' });
    expect(dates(await upcoming(w.id, 'count=3'))).toEqual(['2030-12-19', '2030-12-26', '2031-01-02']);
    const q = await createSub(app, cookie, { billingFrequency: 'quarterly', anchorDate: '2030-11-30', startDate: '2030-01-15', nextBillingDate: '2030-11-30' });
    expect(dates(await upcoming(q.id, 'count=3'))).toEqual(['2030-11-30', '2031-02-28', '2031-05-30']);
    const y = await createSub(app, cookie, { billingFrequency: 'yearly', anchorDate: '2030-02-28', startDate: '2030-01-15', nextBillingDate: '2030-02-28' });
    expect(dates(await upcoming(y.id, 'count=2'))).toEqual(['2030-02-28', '2031-02-28']);
    const leap = await createSub(app, cookie, { billingFrequency: 'yearly', anchorDate: '2028-02-29', startDate: '2028-02-29', nextBillingDate: '2031-02-28' });
    expect(dates(await upcoming(leap.id, 'count=3'))).toEqual(['2031-02-28', '2032-02-29', '2033-02-28']);
  });

  it('starts from the rolled-forward date for a stale subscription (and still writes nothing)', async () => {
    const id = await stale();
    const before = await row(id);
    expect(dates(await upcoming(id, 'count=3'))).toEqual(['2030-02-05', '2030-03-05', '2030-04-05']);
    expect(await row(id)).toEqual(before);
  });

  it('trial: only until the trial end date has passed; paused/cancelled/archived: none', async () => {
    const live = await insertSub(pool, userId, { status: 'trial', trial_end_date: '2030-01-20', next_billing_date: '2030-01-20', anchor_date: '2030-01-20' });
    expect(dates(await upcoming(live, 'count=2'))).toEqual(['2030-01-20', '2030-02-20']);
    const ended = await insertSub(pool, userId, { status: 'trial', trial_end_date: '2030-01-05', next_billing_date: '2030-01-05', anchor_date: '2030-01-05', start_date: '2029-12-01' });
    expect((await upcoming(ended)).body.data).toEqual([]);
    for (const status of ['paused', 'cancelled', 'archived'] as const) {
      const id = await insertSub(pool, userId, { status, ...(status === 'cancelled' ? { cancelled_on: '2030-01-10' } : {}), ...(status === 'archived' ? { status_before_archive: 'active' } : {}) });
      expect((await upcoming(id)).body.data, status).toEqual([]);
    }
  });

  it('defaults to 6; accepts 1 and 24; rejects 0, 25 and junk', async () => {
    const { id } = await createSub(app, cookie);
    expect((await upcoming(id)).body.data).toHaveLength(6);
    expect((await upcoming(id, 'count=1')).body.data).toHaveLength(1);
    expect((await upcoming(id, 'count=24')).body.data).toHaveLength(24);
    for (const qs of ['count=0', 'count=25', 'count=1.5', 'count=x', 'count=', 'foo=1', 'count=1&count=2']) {
      expect((await upcoming(id, qs)).status, qs).toBe(422);
    }
  });

  it('creates no payment and changes no data', async () => {
    const { id } = await createSub(app, cookie);
    const before = await allRows();
    await upcoming(id, 'count=24').expect(200);
    expect(await allRows()).toEqual(before);
    expect(await count('payments')).toBe(0);
  });

  it('is owner-only: B gets the same 404 as for a missing id; anonymous gets 401', async () => {
    const { id } = await createSub(app, cookie);
    const b = client(app, (await registerUser(app)).cookie);
    const asB = await b.get(`/api/subscriptions/${id}/upcoming`);
    expect(asB.status).toBe(404);
    expect(asB.body).toEqual((await b.get('/api/subscriptions/00000000-0000-4000-8000-000000000000/upcoming')).body);
    expect((await b.get('/api/subscriptions/nope/upcoming')).status).toBe(404);
    expect((await client(app).get(`/api/subscriptions/${id}/upcoming`)).status).toBe(401);
  });
});
