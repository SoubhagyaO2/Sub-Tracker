import { ACTION_FROM, STATUSES, STATUS_ACTIONS, type StatusAction, type SubscriptionStatus } from '@subcycle/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { client, createCtx, insertSub, registerUser, resetDb, userIdOf, type SubRowOverrides } from './helpers.js';

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

const act = (id: string, body: unknown) => api.post(`/api/subscriptions/${id}/status`, body);
const row = async (id: string) => (await pool.query('SELECT * FROM subscriptions WHERE id = $1', [id])).rows[0];
const count = async (t: string) => (await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n as number;

const seeds: Record<SubscriptionStatus, SubRowOverrides> = {
  active: { status: 'active' },
  trial: { status: 'trial', trial_end_date: '2030-02-01' },
  paused: { status: 'paused' },
  cancelled: { status: 'cancelled', cancelled_on: '2030-01-10' },
  archived: { status: 'archived', status_before_archive: 'active' },
};
const seed = (status: SubscriptionStatus, extra: SubRowOverrides = {}) => insertSub(pool, userId, { ...seeds[status], ...extra });

describe('POST /api/subscriptions/:id/status: full transition matrix', () => {
  const bodyFor = (action: StatusAction, status: SubscriptionStatus) =>
    action === 'restore' && status === 'cancelled' ? { action, nextBillingDate: '2030-03-01' } : { action };
  const matrix = STATUSES.flatMap((s) => STATUS_ACTIONS.map((a) => [s, a, ACTION_FROM[a].includes(s)] as const));

  it.each(matrix)('%s + %s -> %s', async (status, action, allowed) => {
    const id = await seed(status);
    const res = await act(id, bodyFor(action, status));
    if (allowed) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const resulting: Record<StatusAction, SubscriptionStatus> = {
        pause: 'paused', resume: 'active', convert: 'active', cancel: 'cancelled', archive: 'archived',
        restore: status === 'cancelled' ? 'active' : 'active', // archived seed was archived from "active"
      };
      expect(res.body.data.status).toBe(resulting[action]);
      expect((await row(id)).status).toBe(resulting[action]);
    } else {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_TRANSITION');
      expect((await row(id)).status).toBe(status); // nothing changed
    }
  });

  it('allowedActions in responses always matches what the endpoint accepts', async () => {
    for (const status of STATUSES) {
      const id = await seed(status);
      const dto = (await api.get(`/api/subscriptions/${id}`)).body.data;
      expect(dto.allowedActions.sort()).toEqual(STATUS_ACTIONS.filter((a) => ACTION_FROM[a].includes(status)).sort());
    }
  });
});

describe('pause / resume', () => {
  it('pause keeps the schedule and all other data', async () => {
    const id = await seed('active');
    const res = await act(id, { action: 'pause' });
    expect(res.body.data).toMatchObject({ status: 'paused', nextBillingDate: '2030-02-01', anchorDate: '2030-02-01', amountMinor: 10000, allowedActions: ['resume', 'cancel', 'archive'] });
  });
  it('resume restarts billing; a still-current schedule is kept', async () => {
    const id = await seed('paused');
    const res = await act(id, { action: 'resume' });
    expect(res.body.data).toMatchObject({ status: 'active', nextBillingDate: '2030-02-01', anchorDate: '2030-02-01' });
  });
  it('resume after the stored date passed requires a new date, which becomes the anchor', async () => {
    const id = await seed('paused', { next_billing_date: '2030-01-05', anchor_date: '2030-01-05' });
    const missing = await act(id, { action: 'resume' });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0].path).toBe('nextBillingDate');
    expect((await row(id)).status).toBe('paused');
    expect((await act(id, { action: 'resume', nextBillingDate: '2030-01-14' })).status).toBe(422); // past
    const ok = await act(id, { action: 'resume', nextBillingDate: '2030-01-31' });
    expect(ok.body.data).toMatchObject({ status: 'active', nextBillingDate: '2030-01-31', anchorDate: '2030-01-31' });
  });
  it('resume accepts today as the boundary', async () => {
    const id = await seed('paused', { next_billing_date: '2030-01-05', anchor_date: '2030-01-05' });
    expect((await act(id, { action: 'resume', nextBillingDate: '2030-01-15' })).status).toBe(200);
  });
});

describe('convert (trial to active)', () => {
  it('keeps the trial end date as history and the billing schedule', async () => {
    const id = await seed('trial');
    const res = await act(id, { action: 'convert' });
    expect(res.body.data).toMatchObject({ status: 'active', trialEndDate: '2030-02-01', nextBillingDate: '2030-02-01' });
  });
  it('requires a date when the trial ended in the past', async () => {
    const id = await seed('trial', { trial_end_date: '2030-01-05', next_billing_date: '2030-01-05', anchor_date: '2030-01-05' });
    expect((await act(id, { action: 'convert' })).status).toBe(422);
    expect((await act(id, { action: 'convert', nextBillingDate: '2030-02-05' })).body.data.status).toBe('active');
  });
});

describe('cancel (records a cancellation the user completed externally)', () => {
  it('defaults the date to the user’s today', async () => {
    const id = await seed('active');
    const res = await act(id, { action: 'cancel' });
    expect(res.body.data).toMatchObject({ status: 'cancelled', cancelledOn: '2030-01-15', allowedActions: ['archive', 'restore'] });
  });
  it('uses the user’s time zone for "today"', async () => {
    clock.set('2030-01-15T20:00:00Z'); // already the 16th in Kolkata
    expect((await act(await seed('active'), { action: 'cancel' })).body.data.cancelledOn).toBe('2030-01-16');
  });
  it('accepts a past date and the start-date boundary, rejects future and pre-start dates', async () => {
    expect((await act(await seed('active'), { action: 'cancel', cancelledOn: '2030-01-10' })).body.data.cancelledOn).toBe('2030-01-10');
    expect((await act(await seed('active'), { action: 'cancel', cancelledOn: '2030-01-01' })).status).toBe(200); // == start date
    const future = await act(await seed('active'), { action: 'cancel', cancelledOn: '2030-01-16' });
    expect(future.status).toBe(422);
    expect(future.body.error.details[0].path).toBe('cancelledOn');
    expect((await act(await seed('active'), { action: 'cancel', cancelledOn: '2029-12-31' })).status).toBe(422);
  });
  it('works from active, trial and paused; changes nothing else; creates no payments', async () => {
    for (const status of ['active', 'trial', 'paused'] as const) {
      const id = await seed(status);
      const before = await row(id);
      const res = await act(id, { action: 'cancel' });
      expect(res.status).toBe(200);
      const after = await row(id);
      expect({ ...after, status: null, cancelled_on: null, updated_at: null }).toEqual({ ...before, status: null, cancelled_on: null, updated_at: null });
    }
    expect(await count('payments')).toBe(0);
  });
  it('cannot be repeated', async () => {
    const id = await seed('active');
    await act(id, { action: 'cancel' }).expect(200);
    expect((await act(id, { action: 'cancel' })).status).toBe(409);
  });
});

describe('archive / restore', () => {
  it('archive stores the previous status; restore returns to it, for every origin status', async () => {
    for (const status of ['active', 'trial', 'paused', 'cancelled'] as const) {
      const id = await seed(status);
      const archived = await act(id, { action: 'archive' });
      expect(archived.body.data).toMatchObject({ status: 'archived', allowedActions: ['restore'] });
      expect((await row(id)).status_before_archive).toBe(status);
      const restored = await act(id, { action: 'restore' });
      expect(restored.status, status).toBe(200);
      expect(restored.body.data.status).toBe(status);
      expect((await row(id)).status_before_archive).toBeNull();
    }
  });
  it('an archived+cancelled subscription keeps its cancellation date through restore', async () => {
    const id = await seed('cancelled');
    await act(id, { action: 'archive' });
    expect((await act(id, { action: 'restore' })).body.data).toMatchObject({ status: 'cancelled', cancelledOn: '2030-01-10' });
  });
  it('restoring an archived active subscription whose date passed requires a new date', async () => {
    const id = await seed('archived', { status_before_archive: 'active', next_billing_date: '2030-01-05', anchor_date: '2030-01-05' });
    expect((await act(id, { action: 'restore' })).status).toBe(422);
    expect((await act(id, { action: 'restore', nextBillingDate: '2030-02-05' })).body.data).toMatchObject({ status: 'active', nextBillingDate: '2030-02-05', anchorDate: '2030-02-05' });
  });
  it('restoring archived paused/cancelled rejects a billing date (they do not bill)', async () => {
    for (const before of ['paused', 'cancelled'] as const) {
      const id = await seed('archived', { status_before_archive: before, cancelled_on: before === 'cancelled' ? '2030-01-10' : null });
      const res = await act(id, { action: 'restore', nextBillingDate: '2030-03-01' });
      expect(res.status, before).toBe(422);
      expect((await row(id)).status).toBe('archived');
    }
  });
  it('restoring a CANCELLED subscription (re-subscribing) requires a confirmed future date and clears cancelledOn', async () => {
    const id = await seed('cancelled');
    const missing = await act(id, { action: 'restore' });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0].path).toBe('nextBillingDate');
    expect((await act(id, { action: 'restore', nextBillingDate: '2030-01-14' })).status).toBe(422);
    const ok = await act(id, { action: 'restore', nextBillingDate: '2030-03-01' });
    expect(ok.body.data).toMatchObject({ status: 'active', cancelledOn: null, nextBillingDate: '2030-03-01', anchorDate: '2030-03-01' });
    expect((await row(id)).cancelled_on).toBeNull();
  });
  it('re-subscribing before the start date is rejected', async () => {
    const id = await seed('cancelled', { start_date: '2030-06-01' });
    expect((await act(id, { action: 'restore', nextBillingDate: '2030-03-01' })).status).toBe(422);
  });
});

describe('request validation', () => {
  it.each([
    ['missing action', {}],
    ['unknown action', { action: 'delete' }],
    ['non-string action', { action: 5 }],
    ['wrong-case action', { action: 'PAUSE' }],
    ['extra key', { action: 'pause', status: 'cancelled' }],
    ['userId', { action: 'pause', userId: 'x' }],
    ['bad date format', { action: 'cancel', cancelledOn: '15/01/2030' }],
    ['invalid calendar date', { action: 'cancel', cancelledOn: '2030-02-30' }],
  ])('rejects %s', async (_n, body) => {
    const id = await seed('active');
    const res = await act(id, body);
    expect(res.status).toBe(422);
    expect((await row(id)).status).toBe('active');
  });
  it('rejects parameters that do not belong to the action', async () => {
    const id = await seed('active');
    expect((await act(id, { action: 'pause', cancelledOn: '2030-01-10' })).status).toBe(422);
    expect((await act(id, { action: 'pause', nextBillingDate: '2030-03-01' })).status).toBe(422);
    expect((await act(id, { action: 'cancel', nextBillingDate: '2030-03-01' })).status).toBe(422);
    expect((await row(id)).status).toBe('active');
  });
  it('404s unknown / malformed ids', async () => {
    expect((await act('00000000-0000-0000-0000-000000000000', { action: 'pause' })).status).toBe(404);
    expect((await act('nope', { action: 'pause' })).status).toBe(404);
  });
});

describe('concurrency', () => {
  it('two simultaneous pauses: exactly one wins, the other gets 409 (row is locked during the transition)', async () => {
    const id = await seed('active');
    const results = await Promise.all([act(id, { action: 'pause' }), act(id, { action: 'pause' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await row(id)).status).toBe('paused');
  });
});

describe('status is only reachable through the transition endpoint', () => {
  it('PATCH cannot change status or cancellation fields (no way to fake a cancelled state)', async () => {
    const id = await seed('active');
    for (const body of [{ status: 'cancelled' }, { cancelledOn: '2030-01-10' }, { status: 'archived' }]) {
      expect((await api.patch(`/api/subscriptions/${id}`, body)).status).toBe(422);
    }
    expect((await row(id)).status).toBe('active');
  });
});
