import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF, PASSWORD, SUB, client, createCtx, createSub, insertSub, registerUser, resetDb, sessionCookie, userIdOf } from './helpers.js';
import request from 'supertest';

// Fake "now": 2030-01-15T10:00Z => 2030-01-15 for the default Asia/Kolkata user.
const ctx = createCtx();
const { app, pool, clock } = ctx;
let cookie: string;
let userId: string;
let email: string;
let api: ReturnType<typeof client>;

beforeEach(async () => {
  await resetDb(pool);
  clock.set('2030-01-15T10:00:00.000Z');
  const reg = await registerUser(app);
  cookie = reg.cookie;
  email = reg.email;
  userId = userIdOf(reg.res);
  api = client(app, cookie);
});
afterAll(() => pool.end());

/** Moves the clock and logs in again, because a jump of weeks legitimately outlives the 30-day session. */
async function reloginAt(iso: string) {
  clock.set(iso);
  const res = await request(app).post('/api/auth/login').set(CSRF).send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  cookie = sessionCookie(res)!;
  api = client(app, cookie);
}

const count = async (table: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
const fieldsOf = (res: request.Response) => (res.body.error.details as { path: string }[]).map((d) => d.path);

describe('POST /api/subscriptions', () => {
  it('creates with sensible defaults and never creates payment records', async () => {
    const res = await api.post('/api/subscriptions', SUB);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Netflix', category: 'other', amountMinor: 64900, currency: 'INR', billingFrequency: 'monthly',
      monthlyEquivalentMinor: 64900, status: 'active', nextBillingDate: '2030-02-01', anchorDate: '2030-02-01',
      startDate: '2030-01-15', trialEndDate: null, cancelledOn: null, remindersEnabled: true, icon: null,
      allowedActions: ['pause', 'cancel', 'archive'],
    });
    expect(res.body.data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.data).not.toHaveProperty('userId');
    expect(res.body.data).not.toHaveProperty('user_id');
    expect(await count('payments')).toBe(0);
    expect(await count('subscription_price_history')).toBe(0);
    expect(await count('reminders')).toBe(0);
  });

  it('stores every optional field, trimmed and normalized', async () => {
    const res = await api.post('/api/subscriptions', {
      ...SUB, name: '  Spotify Premium ', category: 'music', currency: 'usd', amountMinor: 1199, billingFrequency: 'yearly',
      nextBillingDate: '2030-06-30', startDate: '2029-06-30', anchorDate: '2029-06-30'.replace('2029', '2030'),
      paymentMethodLabel: ' HDFC card ••12 ', websiteUrl: 'https://www.spotify.com', cancellationUrl: 'https://www.spotify.com/account/cancel',
      notes: 'Family plan\nshared with Sam', usageLevel: 'often', reminderLeadDays: 7, remindersEnabled: false,
      icon: { kind: 'emoji', value: '🎵' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Spotify Premium', currency: 'USD', category: 'music', billingFrequency: 'yearly', monthlyEquivalentMinor: 100,
      paymentMethodLabel: 'HDFC card ••12', websiteUrl: 'https://www.spotify.com', usageLevel: 'often', reminderLeadDays: 7,
      remindersEnabled: false, icon: { kind: 'emoji', value: '🎵' }, notes: 'Family plan\nshared with Sam',
    });
  });

  it('defaults the currency to the user’s preferred currency', async () => {
    await pool.query("UPDATE user_preferences SET currency = 'USD' WHERE user_id = $1", [userId]);
    expect((await api.post('/api/subscriptions', SUB)).body.data.currency).toBe('USD');
    expect((await api.post('/api/subscriptions', { ...SUB, currency: 'EUR' })).body.data.currency).toBe('EUR');
  });

  describe('money', () => {
    it.each([1, 649, 999_999_999_999, 1_000_000_000_000])('round-trips %i exactly', async (amountMinor) => {
      const res = await api.post('/api/subscriptions', { ...SUB, amountMinor });
      expect(res.status).toBe(201);
      expect(res.body.data.amountMinor).toBe(amountMinor);
      const stored = await pool.query('SELECT amount_minor FROM subscriptions WHERE id = $1', [res.body.data.id]);
      expect(stored.rows[0].amount_minor).toBe(amountMinor);
    });
    it.each([[0], [-1], [1.5], [0.1], [1_000_000_000_001], ['649'], [null], [true], [Number.MAX_SAFE_INTEGER]])('rejects amount %j', async (amountMinor) => {
      const res = await api.post('/api/subscriptions', { ...SUB, amountMinor });
      expect(res.status).toBe(422);
      expect(fieldsOf(res)).toContain('amountMinor');
    });
    it('rejects missing and unsupported currency, and malformed codes', async () => {
      for (const currency of ['XXX', 'INRR', 'RS', 123, null, {}]) {
        const res = await api.post('/api/subscriptions', { ...SUB, currency });
        expect(res.status, JSON.stringify(currency)).toBe(422);
        expect(fieldsOf(res)).toContain('currency');
      }
    });
    it('keeps zero-decimal currencies as plain integers', async () => {
      const res = await api.post('/api/subscriptions', { ...SUB, currency: 'JPY', amountMinor: 980 });
      expect(res.body.data).toMatchObject({ currency: 'JPY', amountMinor: 980 });
    });
  });

  describe('date-only values and recurrence anchoring', () => {
    it.each(['2030-03-31', '2030-10-27', '2030-03-10', '2030-12-31', '2032-02-29'])('returns %s unchanged (no time-zone shift)', async (d) => {
      const res = await api.post('/api/subscriptions', { ...SUB, nextBillingDate: d });
      expect(res.status).toBe(201);
      expect(res.body.data.nextBillingDate).toBe(d);
      expect(res.body.data.anchorDate).toBe(d);
      const raw = await pool.query("SELECT next_billing_date::text AS d FROM subscriptions WHERE id = $1", [res.body.data.id]);
      expect(raw.rows[0].d).toBe(d);
    });
    it.each(['2030-02-30', '2030-2-1', '2030-02-01T00:00:00Z', '01/02/2030', '', 'soon', 20300201, '2101-01-01', '1989-12-31', '2030-13-01'])('rejects date %j', async (d) => {
      const res = await api.post('/api/subscriptions', { ...SUB, nextBillingDate: d });
      expect(res.status).toBe(422);
      expect(fieldsOf(res)).toContain('nextBillingDate');
    });
    it('accepts month-end clamping that lies on the anchor schedule, rejects drift', async () => {
      const ok = await api.post('/api/subscriptions', { ...SUB, anchorDate: '2030-01-31', startDate: '2030-01-15', nextBillingDate: '2030-02-28' });
      expect(ok.status).toBe(201);
      expect(ok.body.data).toMatchObject({ anchorDate: '2030-01-31', nextBillingDate: '2030-02-28' });
      const drift = await api.post('/api/subscriptions', { ...SUB, anchorDate: '2030-01-31', nextBillingDate: '2030-02-27' });
      expect(drift.status).toBe(422);
      expect(fieldsOf(drift)).toContain('nextBillingDate');
    });
    it('validates the schedule per frequency', async () => {
      const cases: [Record<string, unknown>, number][] = [
        [{ billingFrequency: 'quarterly', anchorDate: '2030-01-31', nextBillingDate: '2030-04-30' }, 201],
        [{ billingFrequency: 'quarterly', anchorDate: '2030-01-31', nextBillingDate: '2030-02-28' }, 422],
        [{ billingFrequency: 'yearly', anchorDate: '2028-02-29', startDate: '2028-02-29', nextBillingDate: '2031-02-28' }, 201],
        [{ billingFrequency: 'yearly', anchorDate: '2028-02-29', startDate: '2028-02-29', nextBillingDate: '2031-03-01' }, 422],
        [{ billingFrequency: 'weekly', anchorDate: '2030-01-10', nextBillingDate: '2030-01-17' }, 201],
        [{ billingFrequency: 'weekly', anchorDate: '2030-01-10', nextBillingDate: '2030-01-18' }, 422],
        [{ billingFrequency: 'monthly', anchorDate: '2030-03-01', nextBillingDate: '2030-02-01' }, 422], // next before anchor
      ];
      for (const [body, status] of cases) {
        const res = await api.post('/api/subscriptions', { ...SUB, ...body });
        expect(res.status, JSON.stringify(body)).toBe(status);
      }
    });
    it('rejects a next billing date before the start date', async () => {
      const res = await api.post('/api/subscriptions', { ...SUB, startDate: '2030-03-01', nextBillingDate: '2030-02-01' });
      expect(res.status).toBe(422);
      expect(fieldsOf(res)).toContain('nextBillingDate');
    });
    it('requires the next billing date (except for trials with an end date)', async () => {
      const { nextBillingDate: _omit, ...rest } = SUB;
      const res = await api.post('/api/subscriptions', rest);
      expect(res.status).toBe(422);
      expect(fieldsOf(res)).toContain('nextBillingDate');
    });
  });

  describe('"not in the past" uses the user’s own calendar day', () => {
    it('today is allowed, yesterday is not (boundary)', async () => {
      expect((await api.post('/api/subscriptions', { ...SUB, nextBillingDate: '2030-01-15' })).status).toBe(201);
      const res = await api.post('/api/subscriptions', { ...SUB, nextBillingDate: '2030-01-14' });
      expect(res.status).toBe(422);
      expect(fieldsOf(res)).toContain('nextBillingDate');
    });
    it('the same instant is "tomorrow" in Kolkata but still "today" in Los Angeles', async () => {
      clock.set('2030-01-15T20:00:00Z'); // 2030-01-16 01:30 IST, 2030-01-15 12:00 PST
      const kolkata = await api.post('/api/subscriptions', { ...SUB, nextBillingDate: '2030-01-15' });
      expect(kolkata.status).toBe(422);
      await pool.query("UPDATE user_preferences SET timezone = 'America/Los_Angeles' WHERE user_id = $1", [userId]);
      const la = await api.post('/api/subscriptions', { ...SUB, nextBillingDate: '2030-01-15' });
      expect(la.status).toBe(201);
    });
    it('follows DST: just before vs just after local midnight on the US spring-forward date', async () => {
      await pool.query("UPDATE user_preferences SET timezone = 'America/Los_Angeles' WHERE user_id = $1", [userId]);
      await reloginAt('2030-03-11T06:59:59Z'); // 2030-03-10 23:59:59 PDT
      expect((await api.post('/api/subscriptions', { ...SUB, nextBillingDate: '2030-03-10' })).status).toBe(201);
      clock.set('2030-03-11T07:00:00Z'); // 2030-03-11 00:00:00 PDT (same session: only seconds later)
      expect((await api.post('/api/subscriptions', { ...SUB, nextBillingDate: '2030-03-10' })).status).toBe(422);
    });
  });

  describe('trials and status at creation', () => {
    it('trial requires a trial end date; the first charge defaults to that date', async () => {
      const missing = await api.post('/api/subscriptions', { ...SUB, status: 'trial' });
      expect(missing.status).toBe(422);
      const { nextBillingDate: _n, ...rest } = SUB;
      const ok = await api.post('/api/subscriptions', { ...rest, status: 'trial', trialEndDate: '2030-01-29' });
      expect(ok.status).toBe(201);
      expect(ok.body.data).toMatchObject({ status: 'trial', trialEndDate: '2030-01-29', nextBillingDate: '2030-01-29', allowedActions: ['convert', 'cancel', 'archive'] });
    });
    it('trial end cannot precede the start date', async () => {
      const res = await api.post('/api/subscriptions', { ...SUB, status: 'trial', startDate: '2030-01-15', trialEndDate: '2030-01-10' });
      expect(res.status).toBe(422);
      expect(fieldsOf(res)).toContain('trialEndDate');
    });
    it.each(['paused', 'cancelled', 'archived', 'bogus', 42, null])('cannot create directly as %j', async (status) => {
      const res = await api.post('/api/subscriptions', { ...SUB, status });
      expect(res.status).toBe(422);
      expect(fieldsOf(res)).toContain('status');
    });
  });

  describe('strict validation', () => {
    it.each([
      ['userId', { userId: '00000000-0000-0000-0000-000000000001' }],
      ['user_id', { user_id: '00000000-0000-0000-0000-000000000001' }],
      ['id', { id: '00000000-0000-0000-0000-000000000001' }],
      ['createdAt', { createdAt: '2020-01-01T00:00:00Z' }],
      ['statusBeforeArchive', { statusBeforeArchive: 'active' }],
      ['cancelledOn', { cancelledOn: '2030-01-01' }],
      ['an arbitrary key', { isAdmin: true }],
    ])('rejects unknown/forbidden field: %s', async (_n, extra) => {
      const res = await api.post('/api/subscriptions', { ...SUB, ...extra });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await count('subscriptions')).toBe(0);
    });

    it.each([
      ['empty name', { name: '' }, 'name'],
      ['blank name', { name: '    ' }, 'name'],
      ['81-char name', { name: 'x'.repeat(81) }, 'name'],
      ['name with control char', { name: 'Net\u0000flix' }, 'name'],
      ['name with newline', { name: 'Net\nflix' }, 'name'],
      ['numeric name', { name: 123 }, 'name'],
      ['bad category', { category: 'crypto' }, 'category'],
      ['bad frequency', { billingFrequency: 'daily' }, 'billingFrequency'],
      ['uppercase frequency', { billingFrequency: 'MONTHLY' }, 'billingFrequency'],
      ['javascript: url', { websiteUrl: 'javascript:alert(1)' }, 'websiteUrl'],
      ['ftp url', { cancellationUrl: 'ftp://example.com/cancel' }, 'cancellationUrl'],
      ['url with credentials', { websiteUrl: 'https://user:pass@example.com' }, 'websiteUrl'],
      ['url without scheme', { websiteUrl: 'example.com' }, 'websiteUrl'],
      ['url with spaces', { websiteUrl: 'https://exa mple.com' }, 'websiteUrl'],
      ['2049-char url', { websiteUrl: `https://example.com/${'a'.repeat(2030)}` }, 'websiteUrl'],
      ['2001-char notes', { notes: 'n'.repeat(2001) }, 'notes'],
      ['41-char payment label', { paymentMethodLabel: 'p'.repeat(41) }, 'paymentMethodLabel'],
      ['card number in label', { paymentMethodLabel: '4111 1111 1111 1111' }, 'paymentMethodLabel'],
      ['card number in label (no spaces)', { paymentMethodLabel: 'Visa 4111111111111111' }, 'paymentMethodLabel'],
      ['cvv in label', { paymentMethodLabel: 'cvv 123' }, 'paymentMethodLabel'],
      ['card number in notes', { notes: 'pay with 5500-0000-0000-0004' }, 'notes'],
      ['bad usage level', { usageLevel: 'never' }, 'usageLevel'],
      ['reminder lead -1', { reminderLeadDays: -1 }, 'reminderLeadDays'],
      ['reminder lead 61', { reminderLeadDays: 61 }, 'reminderLeadDays'],
      ['reminder lead 1.5', { reminderLeadDays: 1.5 }, 'reminderLeadDays'],
      ['reminders flag as string', { remindersEnabled: 'yes' }, 'remindersEnabled'],
      ['icon with bad kind', { icon: { kind: 'url', value: 'https://x.test/a.png' } }, 'icon.kind'],
      ['icon emoji that is text', { icon: { kind: 'emoji', value: 'abc' } }, 'icon.value'],
      ['icon glyph with uppercase', { icon: { kind: 'glyph', value: 'Music' } }, 'icon.value'],
      ['icon with extra key', { icon: { kind: 'glyph', value: 'music', src: 'x' } }, 'icon'],
    ])('rejects %s', async (_n, patch, path) => {
      const res = await api.post('/api/subscriptions', { ...SUB, ...patch });
      expect(res.status).toBe(422);
      expect(fieldsOf(res)).toContain(path);
    });

    it('accepts boundary lengths: 80-char name, 40-char label, 2000-char notes, 60-day reminder, 0-day reminder', async () => {
      const res = await api.post('/api/subscriptions', {
        ...SUB, name: 'n'.repeat(80), paymentMethodLabel: 'p'.repeat(40), notes: 'x'.repeat(2000), reminderLeadDays: 60,
      });
      expect(res.status).toBe(201);
      expect((await api.post('/api/subscriptions', { ...SUB, reminderLeadDays: 0 })).body.data.reminderLeadDays).toBe(0);
    });

    it('does not mistake legitimate digits for card data', async () => {
      const res = await api.post('/api/subscriptions', { ...SUB, paymentMethodLabel: 'Visa ending 4242', notes: 'Invoice 2024-001, renew by 15th, call 9876543210' });
      expect(res.status).toBe(201);
    });

    it('rejects malformed JSON, non-object bodies and missing bodies', async () => {
      const malformed = await request(app).post('/api/subscriptions').set(CSRF).set('Cookie', cookie).set('Content-Type', 'application/json').send('{"name": ');
      expect(malformed.status).toBe(400);
      expect((await api.post('/api/subscriptions', [])).status).toBe(422);
      expect((await api.post('/api/subscriptions')).status).toBe(422);
    });
  });

  it('enforces a per-user cap of 500 subscriptions (409) without affecting other users', async () => {
    await pool.query(
      `INSERT INTO subscriptions (user_id, name, amount_minor, billing_frequency, anchor_date, next_billing_date, start_date)
       SELECT $1, 'Bulk ' || g, 100, 'monthly', '2030-02-01', '2030-02-01', '2030-01-01' FROM generate_series(1, 500) g`,
      [userId],
    );
    const res = await api.post('/api/subscriptions', SUB);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUBSCRIPTION_LIMIT_REACHED');
    const other = await registerUser(app);
    expect((await client(app, other.cookie).post('/api/subscriptions', SUB)).status).toBe(201);
  });

  it('requires authentication and the CSRF header', async () => {
    expect((await client(app).post('/api/subscriptions', SUB)).status).toBe(401);
    const noCsrf = await request(app).post('/api/subscriptions').set('Cookie', cookie).send(SUB);
    expect(noCsrf.status).toBe(403);
    expect(await count('subscriptions')).toBe(0);
  });
});

describe('GET /api/subscriptions/:id', () => {
  it('returns the subscription', async () => {
    const created = await createSub(app, cookie);
    const res = await api.get(`/api/subscriptions/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(created);
  });
  it('404s unknown and malformed ids with the same body (no information leak)', async () => {
    const unknown = await api.get('/api/subscriptions/00000000-0000-0000-0000-000000000000');
    const malformed = await api.get('/api/subscriptions/not-a-uuid');
    const sqlish = await api.get(`/api/subscriptions/${encodeURIComponent("1' OR '1'='1")}`);
    for (const r of [unknown, malformed, sqlish]) expect(r.status).toBe(404);
    expect(malformed.body).toEqual(unknown.body);
    expect(sqlish.body).toEqual(unknown.body);
  });
});

describe('PATCH /api/subscriptions/:id', () => {
  it('updates only the given fields and leaves the rest untouched', async () => {
    const created = await createSub(app, cookie, { notes: 'keep me', category: 'video' });
    clock.advance(1000);
    const res = await api.patch(`/api/subscriptions/${created.id}`, { name: 'Netflix 4K' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Netflix 4K', notes: 'keep me', category: 'video', amountMinor: 64900, nextBillingDate: '2030-02-01', status: 'active' });
    const row = await pool.query('SELECT created_at, updated_at FROM subscriptions WHERE id = $1', [created.id]);
    expect(row.rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(row.rows[0].created_at.getTime());
  });

  it('clears nullable fields with null or an empty string', async () => {
    const created = await createSub(app, cookie, { notes: 'x', websiteUrl: 'https://a.example', paymentMethodLabel: 'card', usageLevel: 'rarely', reminderLeadDays: 5, icon: { kind: 'glyph', value: 'tv' } });
    const res = await api.patch(`/api/subscriptions/${created.id}`, { notes: null, websiteUrl: '', paymentMethodLabel: '  ', usageLevel: null, reminderLeadDays: null, icon: null });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ notes: null, websiteUrl: null, paymentMethodLabel: null, usageLevel: null, reminderLeadDays: null, icon: null });
  });

  it('rejects empty bodies, unknown keys, status, and ownership fields', async () => {
    const { id } = await createSub(app, cookie);
    for (const body of [{}, { status: 'cancelled' }, { userId: 'x' }, { id: 'x' }, { createdAt: 'x' }, { cancelledOn: '2030-01-01' }, { bogus: 1 }]) {
      const res = await api.patch(`/api/subscriptions/${id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect((await api.get(`/api/subscriptions/${id}`)).body.data.status).toBe('active');
  });

  it('applies the same field validation as create', async () => {
    const { id } = await createSub(app, cookie);
    for (const body of [{ name: '' }, { amountMinor: 0 }, { amountMinor: 1.5 }, { currency: 'XXX' }, { billingFrequency: 'daily' }, { websiteUrl: 'javascript:1' }, { paymentMethodLabel: '4111111111111111' }, { notes: 'cvv 123' }]) {
      expect((await api.patch(`/api/subscriptions/${id}`, body)).status, JSON.stringify(body)).toBe(422);
    }
  });

  describe('price changes are recorded in the same transaction', () => {
    it('writes one price-history row by default', async () => {
      const { id } = await createSub(app, cookie);
      const res = await api.patch(`/api/subscriptions/${id}`, { amountMinor: 79900, priceChangeNote: 'Annual price rise' });
      expect(res.status).toBe(200);
      expect(res.body.data.amountMinor).toBe(79900);
      const h = await pool.query('SELECT old_amount_minor, new_amount_minor, currency, effective_on::text AS effective_on, note FROM subscription_price_history WHERE subscription_id = $1', [id]);
      expect(h.rows).toEqual([{ old_amount_minor: 64900, new_amount_minor: 79900, currency: 'INR', effective_on: '2030-01-15', note: 'Annual price rise' }]);
      expect(await count('payments')).toBe(0);
    });
    it('supports a back-dated effective date, rejects a future one', async () => {
      const { id } = await createSub(app, cookie);
      expect((await api.patch(`/api/subscriptions/${id}`, { amountMinor: 70000, priceChangeEffectiveOn: '2029-12-01' })).status).toBe(200);
      const h = await pool.query('SELECT effective_on::text AS d FROM subscription_price_history WHERE subscription_id = $1', [id]);
      expect(h.rows[0].d).toBe('2029-12-01');
      const future = await api.patch(`/api/subscriptions/${id}`, { amountMinor: 71000, priceChangeEffectiveOn: '2030-01-16' });
      expect(future.status).toBe(422);
      expect(fieldsOf(future)).toContain('priceChangeEffectiveOn');
      expect((await api.get(`/api/subscriptions/${id}`)).body.data.amountMinor).toBe(70000); // failed patch changed nothing
    });
    it('recordPriceChange:false corrects the amount without adding history', async () => {
      const { id } = await createSub(app, cookie);
      expect((await api.patch(`/api/subscriptions/${id}`, { amountMinor: 64000, recordPriceChange: false })).status).toBe(200);
      expect(await count('subscription_price_history')).toBe(0);
    });
    it('no history row when the amount is unchanged or only other fields change', async () => {
      const { id } = await createSub(app, cookie);
      await api.patch(`/api/subscriptions/${id}`, { amountMinor: 64900, name: 'Renamed' });
      expect(await count('subscription_price_history')).toBe(0);
    });
    it('rejects price-change fields when the amount does not actually change', async () => {
      const { id } = await createSub(app, cookie);
      for (const body of [{ priceChangeNote: 'x' }, { recordPriceChange: false }, { priceChangeEffectiveOn: '2030-01-01' }, { amountMinor: 64900, priceChangeNote: 'x' }]) {
        const res = await api.patch(`/api/subscriptions/${id}`, body);
        expect(res.status, JSON.stringify(body)).toBe(422);
      }
    });
    it('rolls back the history row if the update fails validation (atomicity)', async () => {
      const { id } = await createSub(app, cookie);
      const res = await api.patch(`/api/subscriptions/${id}`, { amountMinor: 70000, startDate: '2031-01-01' }); // start after next billing date
      expect(res.status).toBe(422);
      expect(await count('subscription_price_history')).toBe(0);
      expect((await api.get(`/api/subscriptions/${id}`)).body.data.amountMinor).toBe(64900);
    });
  });

  describe('currency is locked once history or payments exist', () => {
    it('can change before any history; writes no history row for the correction', async () => {
      const { id } = await createSub(app, cookie);
      const res = await api.patch(`/api/subscriptions/${id}`, { currency: 'USD', amountMinor: 999 });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ currency: 'USD', amountMinor: 999 });
      expect(await count('subscription_price_history')).toBe(0);
    });
    it('409 CURRENCY_LOCKED after a recorded price change', async () => {
      const { id } = await createSub(app, cookie);
      await api.patch(`/api/subscriptions/${id}`, { amountMinor: 70000 });
      const res = await api.patch(`/api/subscriptions/${id}`, { currency: 'USD' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CURRENCY_LOCKED');
      expect((await api.get(`/api/subscriptions/${id}`)).body.data.currency).toBe('INR');
    });
    it('409 CURRENCY_LOCKED when payments exist; same-currency edits still work', async () => {
      const { id } = await createSub(app, cookie);
      await pool.query("INSERT INTO payments (user_id, subscription_id, amount_minor, currency, paid_on) VALUES ($1,$2,64900,'INR','2030-01-01')", [userId, id]);
      expect((await api.patch(`/api/subscriptions/${id}`, { currency: 'USD' })).status).toBe(409);
      expect((await api.patch(`/api/subscriptions/${id}`, { currency: 'INR', name: 'Same currency ok' })).status).toBe(200);
    });
  });

  describe('schedule edits keep dates consistent', () => {
    it('a new nextBillingDate becomes the new anchor', async () => {
      const { id } = await createSub(app, cookie, { anchorDate: '2030-01-31', startDate: '2030-01-15', nextBillingDate: '2030-02-28' });
      const res = await api.patch(`/api/subscriptions/${id}`, { nextBillingDate: '2030-03-15' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ nextBillingDate: '2030-03-15', anchorDate: '2030-03-15' });
    });
    it('an explicit anchorDate must put the next date on its schedule', async () => {
      const { id } = await createSub(app, cookie);
      expect((await api.patch(`/api/subscriptions/${id}`, { nextBillingDate: '2030-02-28', anchorDate: '2030-01-31' })).status).toBe(200);
      const bad = await api.patch(`/api/subscriptions/${id}`, { anchorDate: '2030-01-30' }); // 2030-02-28 is on the 30th's schedule too (clamped)
      expect(bad.status).toBe(200);
      const off = await api.patch(`/api/subscriptions/${id}`, { anchorDate: '2030-01-15' }); // 15th schedule: next would be Feb 15, not Feb 28
      expect(off.status).toBe(422);
      expect(fieldsOf(off)).toContain('nextBillingDate');
    });
    it('changing the frequency requires a new nextBillingDate and resets the schedule', async () => {
      const { id } = await createSub(app, cookie);
      const missing = await api.patch(`/api/subscriptions/${id}`, { billingFrequency: 'yearly' });
      expect(missing.status).toBe(422);
      expect(fieldsOf(missing)).toContain('nextBillingDate');
      const ok = await api.patch(`/api/subscriptions/${id}`, { billingFrequency: 'yearly', nextBillingDate: '2031-01-20' });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ billingFrequency: 'yearly', anchorDate: '2031-01-20', nextBillingDate: '2031-01-20', monthlyEquivalentMinor: 5408 });
    });
    it('a next billing date in the past is rejected when it is being set', async () => {
      const { id } = await createSub(app, cookie);
      expect((await api.patch(`/api/subscriptions/${id}`, { nextBillingDate: '2030-01-14' })).status).toBe(422);
      expect((await api.patch(`/api/subscriptions/${id}`, { nextBillingDate: '2030-01-15' })).status).toBe(200); // today
    });
    it('REGRESSION: editing unrelated fields never fails just because time has moved past the stored billing date', async () => {
      const { id } = await createSub(app, cookie);
      await reloginAt('2030-03-20T10:00:00Z'); // two months later: stored next date (Feb 1) is now in the past
      const res = await api.patch(`/api/subscriptions/${id}`, { notes: 'still editable', category: 'video' });
      expect(res.status).toBe(200);
      expect(res.body.data.nextBillingDate).toBe('2030-02-01'); // untouched (rolling forward is a later stage)
    });
    it('paused/cancelled subscriptions may keep past dates when edited', async () => {
      const id = await insertSub(pool, userId, { status: 'paused', next_billing_date: '2030-01-05', anchor_date: '2030-01-05' });
      expect((await api.patch(`/api/subscriptions/${id}`, { name: 'ok' })).status).toBe(200);
      expect((await api.patch(`/api/subscriptions/${id}`, { nextBillingDate: '2030-01-06' })).status).toBe(200);
    });
    it('start date cannot move after the next billing date; trial end cannot be cleared on a trial', async () => {
      const { id } = await createSub(app, cookie);
      expect((await api.patch(`/api/subscriptions/${id}`, { startDate: '2030-03-01' })).status).toBe(422);
      const trialId = await insertSub(pool, userId, { status: 'trial', trial_end_date: '2030-02-01' });
      const res = await api.patch(`/api/subscriptions/${trialId}`, { trialEndDate: null });
      expect(res.status).toBe(422);
      expect(fieldsOf(res)).toContain('trialEndDate');
    });
  });

  it('never creates payments and never changes status', async () => {
    const created = await createSub(app, cookie);
    await api.patch(`/api/subscriptions/${created.id}`, { amountMinor: 1, name: 'z', nextBillingDate: '2030-02-05' });
    expect(await count('payments')).toBe(0);
    expect((await api.get(`/api/subscriptions/${created.id}`)).body.data.status).toBe('active');
  });

  it('404s for unknown and malformed ids', async () => {
    expect((await api.patch('/api/subscriptions/00000000-0000-0000-0000-000000000000', { name: 'x' })).status).toBe(404);
    expect((await api.patch('/api/subscriptions/nope', { name: 'x' })).status).toBe(404);
  });
});

describe('DELETE /api/subscriptions/:id', () => {
  it('permanently deletes the subscription and cascades payments and price history', async () => {
    const a = await createSub(app, cookie, { name: 'Delete me' });
    const b = await createSub(app, cookie, { name: 'Keep me' });
    await pool.query("INSERT INTO payments (user_id, subscription_id, amount_minor, currency, paid_on) VALUES ($1,$2,100,'INR','2030-01-01')", [userId, a.id]);
    await api.patch(`/api/subscriptions/${a.id}`, { amountMinor: 70000 });
    expect(await count('payments')).toBe(1);
    expect(await count('subscription_price_history')).toBe(1);

    const res = await api.del(`/api/subscriptions/${a.id}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect((await api.get(`/api/subscriptions/${a.id}`)).status).toBe(404);
    expect(await count('payments')).toBe(0);
    expect(await count('subscription_price_history')).toBe(0);
    expect((await api.get(`/api/subscriptions/${b.id}`)).status).toBe(200);
  });
  it('is not repeatable: a second delete is 404', async () => {
    const { id } = await createSub(app, cookie);
    await api.del(`/api/subscriptions/${id}`).expect(204);
    expect((await api.del(`/api/subscriptions/${id}`)).status).toBe(404);
  });
  it('404s malformed ids and requires CSRF + auth', async () => {
    const { id } = await createSub(app, cookie);
    expect((await api.del('/api/subscriptions/nope')).status).toBe(404);
    expect((await request(app).delete(`/api/subscriptions/${id}`).set('Cookie', cookie)).status).toBe(403);
    expect((await client(app).del(`/api/subscriptions/${id}`)).status).toBe(401);
    expect((await api.get(`/api/subscriptions/${id}`)).status).toBe(200);
  });
});
