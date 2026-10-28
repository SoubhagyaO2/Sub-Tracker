import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, createCtx, createSub, registerUser, resetDb, userIdOf, withFailingTrigger } from './helpers.js';

const ctx = createCtx();
const { app, pool, clock } = ctx;
let userId: string;
let api: ReturnType<typeof client>;
let subId: string; // INR 64900 monthly

beforeEach(async () => {
  await resetDb(pool);
  clock.set('2030-01-15T10:00:00.000Z');
  const reg = await registerUser(app);
  userId = userIdOf(reg.res);
  api = client(app, reg.cookie);
  subId = (await createSub(app, reg.cookie)).id;
});
afterAll(() => pool.end());

const history = (id = subId, qs = '') => api.get(`/api/subscriptions/${id}/price-history${qs ? `?${qs}` : ''}`);
const change = (amountMinor: number, extra: object = {}, id = subId) => api.patch(`/api/subscriptions/${id}`, { amountMinor, ...extra });
const count = async (t: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n as number;
const amountNow = async () => (await pool.query('SELECT amount_minor FROM subscriptions WHERE id = $1', [subId])).rows[0].amount_minor as number;

describe('GET /api/subscriptions/:id/price-history', () => {
  it('is empty for a subscription whose price was never changed (no synthetic initial row)', async () => {
    expect((await history()).body).toEqual({ data: [], meta: { page: 1, pageSize: 25, total: 0 } });
  });

  it('lists recorded changes with the exact old/new amounts, currency, date and note', async () => {
    await change(79900, { priceChangeNote: 'Annual price rise' }).expect(200);
    const res = await history();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { id: expect.any(String), subscriptionId: subId, oldAmountMinor: 64900, newAmountMinor: 79900, currency: 'INR', effectiveOn: '2030-01-15', note: 'Annual price rise', createdAt: expect.any(String) },
    ]);
    expect(res.body.data[0]).not.toHaveProperty('userId');
  });

  it('orders by effective date (newest first), then most recently recorded, then id; back-dated entries sort by their date', async () => {
    await change(70000, { priceChangeEffectiveOn: '2030-01-10', priceChangeNote: 'a' }); // 64900 -> 70000
    await change(75000, { priceChangeEffectiveOn: '2030-01-14', priceChangeNote: 'b' }); // 70000 -> 75000
    await change(80000, { priceChangeEffectiveOn: '2030-01-05', priceChangeNote: 'c' }); // back-dated: recorded last, effective first
    await change(81000, { priceChangeEffectiveOn: '2030-01-14', priceChangeNote: 'd' }); // same day as b, recorded later
    const res = await history();
    expect((res.body.data as { note: string }[]).map((r) => r.note)).toEqual(['d', 'b', 'a', 'c']);
    // The chain of amounts is preserved as recorded.
    const byNote = Object.fromEntries((res.body.data as { note: string; oldAmountMinor: number; newAmountMinor: number }[]).map((r) => [r.note, [r.oldAmountMinor, r.newAmountMinor]]));
    expect(byNote).toEqual({ a: [64900, 70000], b: [70000, 75000], c: [75000, 80000], d: [80000, 81000] });
    expect((await history()).body.data).toEqual(res.body.data); // stable across calls
  });

  it('records nothing for non-changes: same amount, other fields, recordPriceChange:false, or a currency correction', async () => {
    await change(64900, { name: 'rename only' }).expect(200);
    await api.patch(`/api/subscriptions/${subId}`, { notes: 'x' }).expect(200);
    await change(60000, { recordPriceChange: false }).expect(200);
    expect(await count('subscription_price_history')).toBe(0);
    await api.patch(`/api/subscriptions/${subId}`, { currency: 'USD', amountMinor: 999 }).expect(200);
    expect(await count('subscription_price_history')).toBe(0);
    expect((await history()).body.meta.total).toBe(0);
  });

  it('paginates deterministically without skipping or repeating', async () => {
    await pool.query(
      `INSERT INTO subscription_price_history (user_id, subscription_id, old_amount_minor, new_amount_minor, currency, effective_on)
       SELECT $1, $2, 1000 + g, 1001 + g, 'INR', DATE '2029-01-01' + (g % 10) FROM generate_series(1, 30) g`, // many ties on effective_on
      [userId, subId],
    );
    const pass = async () => {
      const seen: string[] = [];
      for (let page = 1; page <= 5; page++) {
        const res = await history(subId, `pageSize=7&page=${page}`);
        expect(res.body.meta).toEqual({ page, pageSize: 7, total: 30 });
        seen.push(...(res.body.data as { id: string }[]).map((r) => r.id));
      }
      return seen;
    };
    const first = await pass();
    expect(new Set(first).size).toBe(30);
    expect(await pass()).toEqual(first); // identical order on a second walk
    expect((await history(subId, 'page=9')).body).toMatchObject({ data: [], meta: { total: 30 } });
  });

  it.each(['page=0', 'page=x', 'pageSize=0', 'pageSize=101', 'userId=1', 'sort=asc', 'page=1&page=2'])('rejects %s', async (qs) => {
    expect((await history(subId, qs)).status).toBe(422);
  });
});

describe('amount changes and their history rows are atomic', () => {
  it('a history-insert failure rolls back the amount change', async () => {
    await withFailingTrigger(pool, 'subscription_price_history', 'INSERT', async () => {
      const res = await change(79900);
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });
    expect(await amountNow()).toBe(64900);
    expect(await count('subscription_price_history')).toBe(0);
  });
  it('a failing subscription UPDATE rolls back the history row that was just inserted', async () => {
    await withFailingTrigger(pool, 'subscriptions', 'UPDATE', async () => {
      const res = await change(79900);
      expect(res.status).toBe(500);
    });
    expect(await amountNow()).toBe(64900);
    expect(await count('subscription_price_history')).toBe(0);
  });
  it('after a failed attempt a retry succeeds and records exactly one row', async () => {
    await withFailingTrigger(pool, 'subscriptions', 'UPDATE', () => change(79900));
    await change(79900).expect(200);
    expect(await amountNow()).toBe(79900);
    expect(await count('subscription_price_history')).toBe(1);
  });
  it('concurrent amount changes serialize: history forms an unbroken chain', async () => {
    await Promise.all([change(70000), change(75000), change(80000)]);
    // Row timestamps are not a reliable order here (a transaction's now() is its START time, and concurrent transactions start in any
    // order), so check the property itself: following the changes from the original price visits every row exactly once, each row
    // starting where the previous one ended, and the last one ends at the current price.
    const rows = (await pool.query('SELECT old_amount_minor o, new_amount_minor n FROM subscription_price_history')).rows as { o: number; n: number }[];
    expect(rows).toHaveLength(3);
    const byOld = new Map(rows.map((r) => [r.o, r]));
    expect(byOld.size).toBe(3); // no two changes start from the same price: nothing was lost to a race
    const chain: { o: number; n: number }[] = [];
    for (let price = 64900, next = byOld.get(price); next; price = next.n, next = byOld.get(price)) chain.push(next);
    expect(chain).toHaveLength(3); // an unbroken chain from the original price
    expect(await amountNow()).toBe(chain[2]!.n);
  });
  it('deleting the subscription removes its history', async () => {
    await change(70000);
    await api.del(`/api/subscriptions/${subId}`).expect(204);
    expect(await count('subscription_price_history')).toBe(0);
  });
});

describe('ownership isolation (price history)', () => {
  const NONEXISTENT = '00000000-0000-4000-8000-000000000000';
  it('B gets the same 404 for A’s subscription as for a missing or malformed id', async () => {
    await change(70000);
    const b = client(app, (await registerUser(app)).cookie);
    const asB = await b.get(`/api/subscriptions/${subId}/price-history`);
    expect(asB.status).toBe(404);
    expect(asB.body).toEqual((await b.get(`/api/subscriptions/${NONEXISTENT}/price-history`)).body);
    expect(asB.body).toEqual((await b.get('/api/subscriptions/not-a-uuid/price-history')).body);
    expect(asB.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });
  it('B’s own history never contains A’s rows', async () => {
    await change(70000);
    const bCookie = (await registerUser(app)).cookie;
    const b = client(app, bCookie);
    const bSub = (await createSub(app, bCookie, { name: 'B sub' })).id;
    await b.patch(`/api/subscriptions/${bSub}`, { amountMinor: 123 }).expect(200);
    const res = await b.get(`/api/subscriptions/${bSub}/price-history`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ subscriptionId: bSub, newAmountMinor: 123 });
  });
  it('B cannot change A’s price (so cannot create A’s history), and requires auth', async () => {
    const b = client(app, (await registerUser(app)).cookie);
    expect((await b.patch(`/api/subscriptions/${subId}`, { amountMinor: 1 })).status).toBe(404);
    expect(await amountNow()).toBe(64900);
    expect(await count('subscription_price_history')).toBe(0);
    expect((await client(app).get(`/api/subscriptions/${subId}/price-history`)).status).toBe(401);
  });
});
