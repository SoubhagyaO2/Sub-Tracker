import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, createCtx, insertSub, registerUser, resetDb, userIdOf } from './helpers.js';
import type request from 'supertest';

const ctx = createCtx();
const { app, pool, clock } = ctx;
let userId: string;
let api: ReturnType<typeof client>;

beforeEach(async () => {
  await resetDb(pool);
  clock.set('2030-01-15T10:00:00.000Z'); // today = 2030-01-15 (Asia/Kolkata)
  const reg = await registerUser(app);
  userId = userIdOf(reg.res);
  api = client(app, reg.cookie);
});
afterAll(() => pool.end());

const names = (res: request.Response) => (res.body.data as { name: string }[]).map((s) => s.name);
const list = (qs = '') => api.get(`/api/subscriptions${qs ? `?${qs}` : ''}`);

/** A varied catalogue used by most tests. created_at order: Alpha(1) < ... < Hotel(8). */
async function seedCatalogue() {
  const rows: [string, Record<string, unknown>][] = [
    ['Alpha', { category: 'video', amount_minor: 64900, billing_frequency: 'monthly', next_billing_date: '2030-01-20', created_at: '2030-01-01T00:00:01Z' }],
    ['bravo', { category: 'music', amount_minor: 11900, billing_frequency: 'monthly', next_billing_date: '2030-01-15', created_at: '2030-01-01T00:00:02Z' }],
    ['Charlie', { category: 'music', amount_minor: 1_200_000, billing_frequency: 'yearly', next_billing_date: '2030-06-01', created_at: '2030-01-01T00:00:03Z' }],
    ['Delta', { category: 'ai_tools', amount_minor: 100, billing_frequency: 'weekly', next_billing_date: '2030-01-22', created_at: '2030-01-01T00:00:04Z' }],
    ['Echo', { category: 'gaming', amount_minor: 30_000, billing_frequency: 'quarterly', next_billing_date: '2030-01-23', created_at: '2030-01-01T00:00:05Z' }],
    ['Foxtrot', { category: 'gaming', amount_minor: 5000, billing_frequency: 'monthly', status: 'paused', next_billing_date: '2030-01-18', created_at: '2030-01-01T00:00:06Z' }],
    ['Golf', { category: 'other', amount_minor: 999, currency: 'USD', billing_frequency: 'monthly', status: 'cancelled', cancelled_on: '2030-01-10', next_billing_date: '2030-01-19', created_at: '2030-01-01T00:00:07Z' }],
    ['Hotel', { category: 'other', amount_minor: 2500, billing_frequency: 'monthly', status: 'archived', status_before_archive: 'active', next_billing_date: '2030-01-17', created_at: '2030-01-01T00:00:08Z' }],
    ['India', { category: 'video', amount_minor: 4900, billing_frequency: 'monthly', status: 'trial', trial_end_date: '2030-01-21', next_billing_date: '2030-01-21', created_at: '2030-01-01T00:00:09Z' }],
  ];
  for (const [name, o] of rows) await insertSub(pool, userId, { name, anchor_date: (o.next_billing_date as string), ...o });
}

describe('GET /api/subscriptions: defaults and shape', () => {
  it('returns an empty page for a new user', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], meta: { page: 1, pageSize: 25, total: 0 } });
  });
  it('hides archived by default and sorts by most recently added', async () => {
    await seedCatalogue();
    const res = await list();
    expect(res.body.meta).toEqual({ page: 1, pageSize: 25, total: 8 });
    expect(names(res)).toEqual(['India', 'Golf', 'Foxtrot', 'Echo', 'Delta', 'Charlie', 'bravo', 'Alpha']);
    expect(res.body.data[0]).toHaveProperty('monthlyEquivalentMinor');
    expect(res.body.data[0]).not.toHaveProperty('userId');
  });
});

describe('filters', () => {
  beforeEach(seedCatalogue);

  it('status: single, comma list, repeated param; archived only when asked', async () => {
    expect(names(await list('status=paused'))).toEqual(['Foxtrot']);
    expect((await list('status=active,trial')).body.meta.total).toBe(6);
    expect((await list('status=active&status=trial')).body.meta.total).toBe(6);
    expect(names(await list('status=archived'))).toEqual(['Hotel']);
    expect((await list('status=archived,cancelled')).body.meta.total).toBe(2);
  });
  it('category and frequency (multi-valued)', async () => {
    expect(names(await list('category=music&sort=name'))).toEqual(['bravo', 'Charlie']);
    expect(names(await list('category=music,video&sort=name'))).toEqual(['Alpha', 'bravo', 'Charlie', 'India']);
    expect(names(await list('frequency=weekly'))).toEqual(['Delta']);
    expect(names(await list('frequency=quarterly,yearly&sort=name'))).toEqual(['Charlie', 'Echo']);
  });
  it('currency', async () => {
    expect(names(await list('currency=USD'))).toEqual(['Golf']);
    expect((await list('currency=INR')).body.meta.total).toBe(7);
    expect((await list('currency=EUR')).body.meta.total).toBe(0);
  });
  it('combines filters with AND', async () => {
    expect(names(await list('status=active&category=gaming'))).toEqual(['Echo']);
    expect(names(await list('category=gaming&frequency=quarterly&currency=INR'))).toEqual(['Echo']);
  });

  describe('search (q)', () => {
    it('is a case-insensitive substring match on the name', async () => {
      expect(names(await list('q=ALP'))).toEqual(['Alpha']);
      expect(names(await list('q=o&sort=name'))).toEqual(['bravo', 'Echo', 'Foxtrot', 'Golf']); // Hotel also matches but is archived
    });
    it('treats LIKE wildcards and backslashes literally', async () => {
      await insertSub(pool, userId, { name: '100% Pure', next_billing_date: '2030-03-01' });
      await insertSub(pool, userId, { name: 'snake_case', next_billing_date: '2030-03-01' });
      await insertSub(pool, userId, { name: 'back\\slash', next_billing_date: '2030-03-01' });
      expect(names(await list('q=' + encodeURIComponent('%')))).toEqual(['100% Pure']);
      expect(names(await list('q=' + encodeURIComponent('_')))).toEqual(['snake_case']);
      expect(names(await list('q=' + encodeURIComponent('\\')))).toEqual(['back\\slash']);
      expect((await list('q=' + encodeURIComponent('%%%'))).body.meta.total).toBe(0);
    });
    it('is safe against SQL injection strings', async () => {
      for (const evil of ["'; DROP TABLE subscriptions; --", "' OR '1'='1", '") OR 1=1 --', 'a\\\' OR 1=1 --']) {
        const res = await list('q=' + encodeURIComponent(evil));
        expect(res.status).toBe(200);
        expect(res.body.meta.total).toBe(0);
      }
      expect((await list()).body.meta.total).toBe(8);
    });
    it('rejects empty, over-long and control-character queries', async () => {
      expect((await list('q=')).status).toBe(422);
      expect((await list('q=' + 'a'.repeat(81))).status).toBe(422);
      expect((await list('q=' + encodeURIComponent('a\u0000b'))).status).toBe(422);
      expect((await list('q=' + 'a'.repeat(80))).status).toBe(200);
    });
  });

  describe('price range (monthly equivalent, exact integer comparison)', () => {
    // Monthly equivalents (INR): Alpha 64900, bravo 11900, Charlie 100000 (yearly 1.2M/12), Delta 433.33 (weekly 100*52/12),
    // Echo 10000 (quarterly 30000/3), Foxtrot 5000 (paused), India 4900 (trial). Golf is USD.
    it('requires currency, and min <= max', async () => {
      const noCurrency = await list('minPrice=100');
      expect(noCurrency.status).toBe(422);
      expect(noCurrency.body.error.details[0].path).toBe('currency');
      expect((await list('currency=INR&minPrice=10&maxPrice=5')).status).toBe(422);
    });
    it('filters on the monthly equivalent, not the raw amount, with inclusive bounds', async () => {
      // Charlie's raw amount is 1,200,000 but it is 100,000 per month; Echo's raw 30,000 is 10,000 per month.
      expect(names(await list('currency=INR&minPrice=10000&maxPrice=11900&sort=name'))).toEqual(['bravo', 'Echo']);
      expect(names(await list('currency=INR&minPrice=100000'))).toEqual(['Charlie']);
      expect(names(await list('currency=INR&maxPrice=100000&minPrice=100000'))).toEqual(['Charlie']);
    });
    it('is exact for fractional monthly equivalents (no rounding at the boundary)', async () => {
      // Delta is exactly 433.33.. per month: included by max 434, excluded by max 433, included by min 433, excluded by min 434.
      expect(names(await list('currency=INR&frequency=weekly&maxPrice=434'))).toEqual(['Delta']);
      expect(names(await list('currency=INR&frequency=weekly&maxPrice=433'))).toEqual([]);
      expect(names(await list('currency=INR&frequency=weekly&minPrice=433'))).toEqual(['Delta']);
      expect(names(await list('currency=INR&frequency=weekly&minPrice=434'))).toEqual([]);
    });
    it('only matches the requested currency', async () => {
      expect(names(await list('currency=USD&minPrice=0'))).toEqual(['Golf']);
    });
    it('rejects non-integer, negative and oversized bounds', async () => {
      for (const qs of ['minPrice=1.5', 'minPrice=-1', 'minPrice=abc', 'maxPrice=1000000000001', 'minPrice=']) {
        expect((await list(`currency=INR&${qs}`)).status, qs).toBe(422);
      }
    });
  });

  describe('upcoming renewal window (renewsWithinDays)', () => {
    it('includes today and day N (inclusive), only active/trial', async () => {
      // today=Jan 15. Active/trial next dates: Alpha 20, bravo 15, Charlie Jun, Delta 22, Echo 23, India(trial) 21.
      // Excluded despite dates in range: Foxtrot (paused, 18), Golf (cancelled, 19), Hotel (archived, 17).
      expect(names(await list('renewsWithinDays=7&sort=nextRenewal'))).toEqual(['bravo', 'Alpha', 'India', 'Delta']);
      expect(names(await list('renewsWithinDays=8&sort=nextRenewal'))).toEqual(['bravo', 'Alpha', 'India', 'Delta', 'Echo']);
      expect(names(await list('renewsWithinDays=1&sort=nextRenewal'))).toEqual(['bravo']);
      expect((await list('renewsWithinDays=366')).body.meta.total).toBe(6);
    });
    it('uses the user’s own calendar day (time zone aware)', async () => {
      clock.set('2030-01-15T20:00:00Z'); // 2030-01-16 in Kolkata, still 2030-01-15 in Los Angeles
      expect(names(await list('renewsWithinDays=1'))).toEqual([]); // window is Jan 16-17: bravo (Jan 15) is behind a Kolkata user
      await pool.query("UPDATE user_preferences SET timezone = 'America/Los_Angeles' WHERE user_id = $1", [userId]);
      expect(names(await list('renewsWithinDays=1'))).toEqual(['bravo']); // window is Jan 15-16 for a Los Angeles user
    });
    it('rejects 0, 367 and non-integers', async () => {
      for (const v of ['0', '367', '1.5', '-1', 'x']) expect((await list(`renewsWithinDays=${v}`)).status, v).toBe(422);
    });
  });
});

describe('sorting', () => {
  beforeEach(seedCatalogue);

  it('name is case-insensitive, asc by default; order flips it', async () => {
    expect(names(await list('sort=name'))).toEqual(['Alpha', 'bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'India']);
    expect(names(await list('sort=name&order=desc'))).toEqual(['India', 'Golf', 'Foxtrot', 'Echo', 'Delta', 'Charlie', 'bravo', 'Alpha']);
  });
  it('nextRenewal asc by default', async () => {
    expect(names(await list('sort=nextRenewal'))).toEqual(['bravo', 'Foxtrot', 'Golf', 'Alpha', 'India', 'Delta', 'Echo', 'Charlie']);
    expect(names(await list('sort=nextRenewal&order=desc'))[0]).toBe('Charlie');
  });
  it('price sorts by exact monthly equivalent, desc by default', async () => {
    // INR monthly eq: Charlie 100000, Alpha 64900, bravo 11900, Echo 10000, Foxtrot 5000, India 4900, Delta 433.3; Golf (USD) 999.
    expect(names(await list('sort=price&currency=INR'))).toEqual(['Charlie', 'Alpha', 'bravo', 'Echo', 'Foxtrot', 'India', 'Delta']);
    expect(names(await list('sort=price&order=asc&currency=INR'))).toEqual(['Delta', 'India', 'Foxtrot', 'Echo', 'bravo', 'Alpha', 'Charlie']);
  });
  it('created: newest first by default, oldest first with order=asc', async () => {
    expect(names(await list('sort=created'))[0]).toBe('India');
    expect(names(await list('sort=created&order=asc'))[0]).toBe('Alpha');
  });
  it('is stable: ties are broken by id so paging never skips or repeats rows', async () => {
    await pool.query('TRUNCATE subscriptions CASCADE');
    for (let i = 0; i < 30; i++) await insertSub(pool, userId, { name: `Same ${i}`, amount_minor: 5000, next_billing_date: '2030-02-01' });
    for (const sort of ['price', 'name', 'nextRenewal', 'created']) {
      const seen: string[] = [];
      for (let page = 1; page <= 5; page++) {
        const res = await list(`sort=${sort}&pageSize=7&page=${page}`);
        seen.push(...(res.body.data as { id: string }[]).map((s) => s.id));
      }
      expect(seen, sort).toHaveLength(30);
      expect(new Set(seen).size, sort).toBe(30);
    }
  });
});

describe('pagination', () => {
  beforeEach(async () => {
    for (let i = 1; i <= 30; i++) {
      await insertSub(pool, userId, { name: `Sub ${String(i).padStart(2, '0')}`, next_billing_date: '2030-02-01', created_at: `2030-01-01T00:00:${String(i).padStart(2, '0')}Z` });
    }
  });
  it('defaults to page 1 of 25', async () => {
    const res = await list();
    expect(res.body.data).toHaveLength(25);
    expect(res.body.meta).toEqual({ page: 1, pageSize: 25, total: 30 });
  });
  it('returns the remainder on the last page and an empty page beyond it (total preserved)', async () => {
    expect((await list('page=2')).body.data).toHaveLength(5);
    const beyond = await list('page=3');
    expect(beyond.status).toBe(200);
    expect(beyond.body.data).toEqual([]);
    expect(beyond.body.meta).toEqual({ page: 3, pageSize: 25, total: 30 });
  });
  it('pages are disjoint and complete', async () => {
    const all: string[] = [];
    for (let p = 1; p <= 6; p++) all.push(...names(await list(`sort=name&pageSize=5&page=${p}`)));
    expect(all).toEqual(Array.from({ length: 30 }, (_, i) => `Sub ${String(i + 1).padStart(2, '0')}`));
  });
  it('accepts the bounds 1 and 100', async () => {
    expect((await list('pageSize=1')).body.data).toHaveLength(1);
    expect((await list('pageSize=100')).body.data).toHaveLength(30);
  });
  it.each(['pageSize=0', 'pageSize=101', 'pageSize=-1', 'pageSize=abc', 'pageSize=1.5', 'pageSize=', 'page=0', 'page=-1', 'page=abc', 'page=100001', 'page=1&page=2'])('rejects %s', async (qs) => {
    const res = await list(qs);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
  it('total reflects filters', async () => {
    expect((await list('q=Sub 1&pageSize=100')).body.meta.total).toBe(10); // matches Sub 10 to Sub 19 only
  });
});

describe('strict allowlists', () => {
  beforeEach(seedCatalogue);
  it.each([
    'userId=00000000-0000-0000-0000-000000000001',
    'user_id=1',
    'foo=bar',
    'sort=password',
    'sort=amount_minor',
    'sort=name;DROP TABLE subscriptions',
    'sort=name&sort=price',
    'sort=',
    'order=sideways',
    'order=asc;--',
    'status=bogus',
    'status=',
    'status=active,bogus',
    'category=crypto',
    'frequency=daily',
    'currency=XXX',
    'currency=inr1',
    'sort[]=name',
  ])('rejects %s', async (qs) => {
    const res = await list(qs);
    expect(res.status, qs).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
  it('the table survives every hostile query', async () => {
    await list("sort=name'; DROP TABLE subscriptions;--");
    expect((await pool.query('SELECT count(*)::int n FROM subscriptions')).rows[0].n).toBe(9);
  });
  it('requires authentication', async () => {
    expect((await client(app).get('/api/subscriptions')).status).toBe(401);
  });
});
