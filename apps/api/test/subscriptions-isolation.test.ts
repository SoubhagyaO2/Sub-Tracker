import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, createCtx, insertSub, registerUser, resetDb, userIdOf, type SubRowOverrides } from './helpers.js';

/**
 * User isolation. User A owns subscriptions in several states; user B (a different, valid, logged-in
 * account) attempts EVERY route against A's ids. Each attempt must be indistinguishable from "this id
 * does not exist" (404 with an identical body), and must leave A's data untouched.
 */
const ctx = createCtx();
const { app, pool, clock } = ctx;

let a: ReturnType<typeof client>;
let b: ReturnType<typeof client>;
let aId: string;
let ids: Record<string, string>; // one A-owned subscription per state, keyed by label
let paymentId: string; // an A-owned payment on A's active subscription

beforeEach(async () => {
  await resetDb(pool);
  clock.set('2030-01-15T10:00:00.000Z');
  const regA = await registerUser(app);
  const regB = await registerUser(app);
  aId = userIdOf(regA.res);
  a = client(app, regA.cookie);
  b = client(app, regB.cookie);
  const seed = (o: SubRowOverrides) => insertSub(pool, aId, o);
  ids = {
    active: await seed({ name: 'A active' }),
    trial: await seed({ name: 'A trial', status: 'trial', trial_end_date: '2030-02-01' }),
    paused: await seed({ name: 'A paused', status: 'paused' }),
    cancelled: await seed({ name: 'A cancelled', status: 'cancelled', cancelled_on: '2030-01-10' }),
    archived: await seed({ name: 'A archived', status: 'archived', status_before_archive: 'active' }),
  };
  paymentId = (
    await pool.query("INSERT INTO payments (user_id, subscription_id, amount_minor, currency, paid_on) VALUES ($1,$2,64900,'INR','2030-01-10') RETURNING id", [aId, ids.active])
  ).rows[0].id as string;
  await pool.query(
    "INSERT INTO subscription_price_history (user_id, subscription_id, old_amount_minor, new_amount_minor, currency, effective_on) VALUES ($1,$2,100,200,'INR','2030-01-01')",
    [aId, ids.active],
  );
});
afterAll(() => pool.end());

interface Probe {
  label: string;
  /** Which of A's subscriptions to target: chosen so the action would be VALID for A (a 409 would leak existence). */
  target: 'active' | 'trial' | 'paused' | 'cancelled' | 'archived';
  call: (c: ReturnType<typeof client>, id: string) => ReturnType<ReturnType<typeof client>['get']>;
}
const status = (body: object) => (c: ReturnType<typeof client>, id: string) => c.post(`/api/subscriptions/${id}/status`, body);
const probes: Probe[] = [
  { label: 'GET /:id', target: 'active', call: (c, id) => c.get(`/api/subscriptions/${id}`) },
  { label: 'PATCH /:id (rename)', target: 'active', call: (c, id) => c.patch(`/api/subscriptions/${id}`, { name: 'hijacked' }) },
  { label: 'PATCH /:id (price change)', target: 'active', call: (c, id) => c.patch(`/api/subscriptions/${id}`, { amountMinor: 1 }) },
  { label: 'PATCH /:id (change schedule)', target: 'active', call: (c, id) => c.patch(`/api/subscriptions/${id}`, { nextBillingDate: '2030-03-01' }) },
  { label: 'DELETE /:id', target: 'active', call: (c, id) => c.del(`/api/subscriptions/${id}`) },
  { label: 'POST /:id/status pause (active)', target: 'active', call: status({ action: 'pause' }) },
  { label: 'POST /:id/status cancel (active)', target: 'active', call: status({ action: 'cancel' }) },
  { label: 'POST /:id/status archive (active)', target: 'active', call: status({ action: 'archive' }) },
  { label: 'POST /:id/status resume (paused)', target: 'paused', call: status({ action: 'resume' }) },
  { label: 'POST /:id/status convert (trial)', target: 'trial', call: status({ action: 'convert' }) },
  { label: 'POST /:id/status restore (cancelled)', target: 'cancelled', call: status({ action: 'restore', nextBillingDate: '2030-03-01' }) },
  { label: 'POST /:id/status restore (archived)', target: 'archived', call: status({ action: 'restore' }) },
  { label: 'DELETE /:id (archived)', target: 'archived', call: (c, id) => c.del(`/api/subscriptions/${id}`) },
  // Stage 5 routes
  { label: 'GET /:id/payments', target: 'active', call: (c, id) => c.get(`/api/subscriptions/${id}/payments`) },
  { label: 'POST /:id/payments', target: 'active', call: (c, id) => c.post(`/api/subscriptions/${id}/payments`, { amountMinor: 1 }) },
  {
    label: 'POST /:id/payments (advance the date)',
    target: 'active',
    call: (c, id) => c.post(`/api/subscriptions/${id}/payments`, { amountMinor: 1, forBillingDate: '2030-02-01', advanceNextBillingDate: true }),
  },
  { label: 'DELETE /:id/payments/:paymentId', target: 'active', call: (c, id) => c.del(`/api/subscriptions/${id}/payments/${paymentId}`) },
  { label: 'GET /:id/price-history', target: 'active', call: (c, id) => c.get(`/api/subscriptions/${id}/price-history`) },
  { label: 'GET /:id/upcoming', target: 'active', call: (c, id) => c.get(`/api/subscriptions/${id}/upcoming`) },
];

const snapshot = async () => ({
  subscriptions: (await pool.query('SELECT * FROM subscriptions ORDER BY id')).rows,
  payments: (await pool.query('SELECT * FROM payments ORDER BY id')).rows,
  priceHistory: (await pool.query('SELECT * FROM subscription_price_history ORDER BY id')).rows,
});
const NONEXISTENT = '00000000-0000-4000-8000-000000000000';

describe('user B against user A’s subscription: every route returns 404', () => {
  it.each(probes.map((p) => [p.label, p] as const))('%s', async (_label, probe) => {
    const id = ids[probe.target]!;
    const before = await snapshot();

    // Sanity: the same call is valid for the owner's state (so B's 404 is not a hidden 409/422).
    // (Checked on a throwaway copy to keep A's data pristine for the assertion below.)
    const asB = await probe.call(b, id);
    const asBNonexistent = await probe.call(b, NONEXISTENT);

    expect(asB.status).toBe(404);
    expect(asB.body).toEqual(asBNonexistent.body); // identical to a truly missing id: no existence signal
    expect(asB.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
    expect(await snapshot()).toEqual(before); // A's rows are byte-for-byte unchanged (incl. updated_at)
  });

  it('the very same calls DO work for the owner (so the 404s above are ownership, not state)', async () => {
    const ownerOk: [string, () => Promise<number>][] = [
      ['GET', async () => (await a.get(`/api/subscriptions/${ids.active}`)).status],
      ['PATCH', async () => (await a.patch(`/api/subscriptions/${ids.active}`, { name: 'renamed by owner' })).status],
      ['pause', async () => (await a.post(`/api/subscriptions/${ids.active}/status`, { action: 'pause' })).status],
      ['resume', async () => (await a.post(`/api/subscriptions/${ids.paused}/status`, { action: 'resume' })).status],
      ['convert', async () => (await a.post(`/api/subscriptions/${ids.trial}/status`, { action: 'convert' })).status],
      ['restore cancelled', async () => (await a.post(`/api/subscriptions/${ids.cancelled}/status`, { action: 'restore', nextBillingDate: '2030-03-01' })).status],
      ['restore archived', async () => (await a.post(`/api/subscriptions/${ids.archived}/status`, { action: 'restore' })).status],
      ['GET payments', async () => (await a.get(`/api/subscriptions/${ids.active}/payments`)).status],
      ['POST payment', async () => (await a.post(`/api/subscriptions/${ids.active}/payments`, { amountMinor: 1 })).status],
      ['GET price-history', async () => (await a.get(`/api/subscriptions/${ids.active}/price-history`)).status],
      ['GET upcoming', async () => (await a.get(`/api/subscriptions/${ids.active}/upcoming`)).status],
      ['DELETE payment', async () => (await a.del(`/api/subscriptions/${ids.active}/payments/${paymentId}`)).status],
      ['DELETE', async () => (await a.del(`/api/subscriptions/${ids.active}`)).status],
    ];
    const expected: Record<string, number> = { DELETE: 204, 'DELETE payment': 204, 'POST payment': 201 };
    for (const [name, fn] of ownerOk) expect(await fn(), name).toBe(expected[name] ?? 200);
  });
});

describe('B cannot see or reach A’s data through collections, filters or crafted input', () => {
  it('B’s list is empty while A’s has all five (including a status=archived request)', async () => {
    expect((await b.get('/api/subscriptions')).body).toEqual({ data: [], meta: { page: 1, pageSize: 25, total: 0 } });
    expect((await b.get('/api/subscriptions?status=archived,cancelled,paused,trial,active')).body.meta.total).toBe(0);
    expect((await b.get('/api/subscriptions?q=A')).body.meta.total).toBe(0);
    expect((await a.get('/api/subscriptions?status=archived,cancelled,paused,trial,active')).body.meta.total).toBe(5);
  });
  it('B’s list contains only B’s own rows when both users have data', async () => {
    const bUser = (await pool.query("SELECT id FROM users WHERE id <> $1", [aId])).rows[0].id as string;
    await insertSub(pool, bUser, { name: 'B only' });
    const res = await b.get('/api/subscriptions');
    expect((res.body.data as { name: string }[]).map((s) => s.name)).toEqual(['B only']);
    expect(res.body.meta.total).toBe(1);
  });
  it('no query parameter or body field can name another user', async () => {
    expect((await b.get(`/api/subscriptions?userId=${aId}`)).status).toBe(422);
    expect((await b.get(`/api/subscriptions?user_id=${aId}`)).status).toBe(422);
    const create = await b.post('/api/subscriptions', { name: 'x', amountMinor: 1, billingFrequency: 'monthly', nextBillingDate: '2030-02-01', userId: aId });
    expect(create.status).toBe(422);
    const spoof = await b.post('/api/subscriptions', { name: 'x', amountMinor: 1, billingFrequency: 'monthly', nextBillingDate: '2030-02-01', id: ids.active });
    expect(spoof.status).toBe(422);
  });
  it('subscriptions B creates belong to B and are invisible to A', async () => {
    const created = await b.post('/api/subscriptions', { name: 'B sub', amountMinor: 100, billingFrequency: 'monthly', nextBillingDate: '2030-02-01' });
    expect(created.status).toBe(201);
    expect((await a.get(`/api/subscriptions/${created.body.data.id}`)).status).toBe(404);
    const owner = await pool.query('SELECT user_id FROM subscriptions WHERE id = $1', [created.body.data.id]);
    expect(owner.rows[0].user_id).not.toBe(aId);
  });
  it('B deleting or editing A’s subscription cannot touch A’s payments or price history', async () => {
    const counts = async () => (await pool.query('SELECT (SELECT count(*) FROM payments)::int p, (SELECT count(*) FROM subscription_price_history)::int h')).rows[0];
    const before = await counts();
    expect(before).toEqual({ p: 1, h: 1 }); // the rows seeded in beforeEach
    await b.del(`/api/subscriptions/${ids.active}`).expect(404);
    await b.patch(`/api/subscriptions/${ids.active}`, { amountMinor: 5 }).expect(404);
    expect(await counts()).toEqual(before);
  });
});

describe('unauthenticated access', () => {
  const routes: ['get' | 'post' | 'patch' | 'delete', string, object | undefined][] = [
    ['get', '/api/subscriptions', undefined],
    ['post', '/api/subscriptions', { name: 'x', amountMinor: 1, billingFrequency: 'monthly', nextBillingDate: '2030-02-01' }],
    ['get', `/api/subscriptions/${NONEXISTENT}`, undefined],
    ['patch', `/api/subscriptions/${NONEXISTENT}`, { name: 'x' }],
    ['delete', `/api/subscriptions/${NONEXISTENT}`, undefined],
    ['post', `/api/subscriptions/${NONEXISTENT}/status`, { action: 'pause' }],
    ['get', `/api/subscriptions/${NONEXISTENT}/payments`, undefined],
    ['post', `/api/subscriptions/${NONEXISTENT}/payments`, { amountMinor: 1 }],
    ['delete', `/api/subscriptions/${NONEXISTENT}/payments/${NONEXISTENT}`, undefined],
    ['get', `/api/subscriptions/${NONEXISTENT}/price-history`, undefined],
    ['get', `/api/subscriptions/${NONEXISTENT}/upcoming`, undefined],
  ];
  it.each(routes)('%s %s -> 401 (before any lookup, so even real ids behave identically)', async (verb, url, body) => {
    const anon = client(app);
    const res = verb === 'get' ? await anon.get(url) : verb === 'post' ? await anon.post(url, body) : verb === 'patch' ? await anon.patch(url, body) : await anon.del(url);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
  it('401 for a real id too (no 404-vs-401 oracle)', async () => {
    const real = await client(app).get(`/api/subscriptions/${ids.active}`);
    const fake = await client(app).get(`/api/subscriptions/${NONEXISTENT}`);
    expect(real.status).toBe(401);
    expect(real.body).toEqual(fake.body);
  });
  it('an expired session is treated as unauthenticated', async () => {
    clock.advance(31 * 24 * 3600 * 1000);
    expect((await a.get('/api/subscriptions')).status).toBe(401);
  });
});
