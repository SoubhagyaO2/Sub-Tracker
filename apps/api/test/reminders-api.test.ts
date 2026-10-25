import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runSchedulerCycle } from '../src/scheduler/cycle.js';
import { FakeMailer, T0, client, createCtx, createSub, loginCookie, registerUser, remindersOf, resetDb, setPrefs, userIdOf } from './helpers.js';

const mailer = new FakeMailer();
const ctx = createCtx({ mailer });
const { app, pool, clock, env } = ctx;
let userId: string;
let email: string;
let cookie: string;
let api: ReturnType<typeof client>;
const NONEXISTENT = '00000000-0000-4000-8000-000000000000';

beforeEach(async () => {
  await resetDb(pool);
  clock.set(T0);
  Object.assign(mailer, { sent: [], errors: [], attempts: 0, configured: true, onSend: undefined });
  const reg = await registerUser(app);
  userId = userIdOf(reg.res);
  email = reg.email;
  cookie = reg.cookie;
  api = client(app, cookie);
});
afterAll(() => pool.end());

const list = (qs = '') => api.get(`/api/reminders${qs ? `?${qs}` : ''}`);
const snapshot = async () => (await pool.query('SELECT * FROM reminders ORDER BY id')).rows;

/**
 * Two renewals whose reminders were due while nobody was looking, then one scheduler pass on Jan 31. Resulting rows (8):
 *   Feb renewals: 2 in-app SENT, 2 email SKIPPED (no provider configured)
 *   March renewals (planned by the same pass, not yet due): 2 in-app + 2 email PENDING
 */
async function delivered() {
  await createSub(app, cookie, { name: 'Netflix', nextBillingDate: '2030-02-01' });
  await createSub(app, cookie, { name: 'Spotify', nextBillingDate: '2030-02-03' });
  await setPrefs(pool, userId, { email_reminders_enabled: true });
  mailer.configured = false; // email cannot be delivered here
  await runSchedulerCycle(env); // plans
  clock.set('2030-01-31T10:00:00Z');
  await runSchedulerCycle(env); // delivers
  cookie = await loginCookie(app, email); // 16 days passed: the old session has legitimately expired
  api = client(app, cookie);
}

describe('GET /api/reminders', () => {
  it('is empty for a new user', async () => {
    expect((await list()).body).toEqual({ data: [], meta: { page: 1, pageSize: 25, total: 0, unread: 0 } });
  });

  it('shows delivered in-app reminders and the truthful state of email ones', async () => {
    await delivered();
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ total: 8, unread: 2 });
    type Row = { channel: string; status: string; skipReason: string | null; sentAt: string | null };
    const rows = res.body.data as Row[];
    const sent = rows.filter((r) => r.channel === 'in_app' && r.status === 'sent');
    const skipped = rows.filter((r) => r.channel === 'email' && r.status === 'skipped');
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ kind: 'renewal', leadDays: 3, readAt: null, skipReason: null, sentAt: expect.any(String), attempts: 1 });
    expect(skipped).toHaveLength(2);
    expect(skipped.every((r) => r.skipReason === 'smtp_not_configured' && r.sentAt === null)).toBe(true); // never "sent"
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(4);
    expect(res.body.data[0]).toEqual(expect.objectContaining({ id: expect.any(String), subscriptionId: expect.any(String), subscriptionName: expect.any(String), targetDate: expect.any(String), remindAt: expect.any(String), lastError: null }));
    expect(res.body.data[0]).not.toHaveProperty('userId');
    expect(mailer.sent).toHaveLength(0);
  });

  it('filters by channel, status and unread; paginates deterministically', async () => {
    await delivered();
    expect((await list('channel=email')).body.meta.total).toBe(4);
    expect((await list('channel=in_app&status=sent')).body.meta.total).toBe(2);
    expect((await list('status=skipped,failed')).body.meta.total).toBe(2);
    expect((await list('status=pending')).body.meta.total).toBe(4);
    expect((await list('status=pending')).body.data.every((r: { status: string }) => r.status === 'pending')).toBe(true);
    expect((await list('unread=true')).body.meta.total).toBe(2);
    const pages = [await list('pageSize=3&page=1'), await list('pageSize=3&page=2'), await list('pageSize=3&page=3')];
    expect(pages.map((p) => p.body.data.length)).toEqual([3, 3, 2]);
    expect(new Set(pages.flatMap((p) => p.body.data.map((r: { id: string }) => r.id))).size).toBe(8); // none repeated, none lost
    expect((await list('page=9')).body).toMatchObject({ data: [], meta: { total: 8 } });
  });

  it.each(['channel=sms', 'status=done', 'status=', 'unread=false', 'pageSize=101', 'page=0', 'userId=x', 'foo=bar', 'channel=email&channel=in_app'])('rejects %s', async (qs) => {
    const res = await list(qs);
    expect(res.status, qs).toBe(422);
  });

  it('is read-only', async () => {
    await delivered();
    const before = await snapshot();
    for (const qs of ['', 'unread=true', 'channel=email', 'status=sent']) await list(qs).expect(200);
    expect(await snapshot()).toEqual(before);
  });

  it('only ever returns the signed-in user’s reminders', async () => {
    await delivered();
    const b = await registerUser(app);
    expect((await client(app, b.cookie).get('/api/reminders')).body).toEqual({ data: [], meta: { page: 1, pageSize: 25, total: 0, unread: 0 } });
    expect(JSON.stringify((await client(app, b.cookie).get('/api/reminders?status=sent,skipped,pending')).body)).not.toContain('Netflix');
  });

  it('requires a session', async () => {
    expect((await client(app).get('/api/reminders')).status).toBe(401);
  });
});

describe('POST /api/reminders/:id/dismiss', () => {
  it('marks a delivered in-app reminder as read (idempotent), and the unread count follows', async () => {
    await delivered();
    const target = (await list('channel=in_app&status=sent')).body.data[0];
    clock.set('2030-01-31T11:00:00Z');
    const first = await api.post(`/api/reminders/${target.id}/dismiss`);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ id: target.id, readAt: '2030-01-31T11:00:00.000Z', status: 'sent' });
    clock.set('2030-01-31T12:00:00Z');
    expect((await api.post(`/api/reminders/${target.id}/dismiss`)).body.data.readAt).toBe('2030-01-31T11:00:00.000Z'); // unchanged
    expect((await list()).body.meta.unread).toBe(1);
    expect((await list('unread=true')).body.meta.total).toBe(1);
  });

  it('only delivered in-app reminders can be dismissed: pending, skipped and email ones are "not found"', async () => {
    await createSub(app, cookie, { nextBillingDate: '2030-02-01' });
    await setPrefs(pool, userId, { email_reminders_enabled: true });
    await runSchedulerCycle(env); // planned, not yet due
    const rows = await remindersOf(pool, userId);
    const pending = rows.find((r) => r.channel === 'in_app')!;
    expect((await api.post(`/api/reminders/${pending.id}/dismiss`)).status).toBe(404);
    const email = rows.find((r) => r.channel === 'email')!;
    expect((await api.post(`/api/reminders/${email.id}/dismiss`)).status).toBe(404);
    expect((await remindersOf(pool, userId)).every((r) => r.read_at === null)).toBe(true);
  });

  it('another user’s reminder is indistinguishable from one that does not exist', async () => {
    await delivered();
    const mine = (await list('channel=in_app&status=sent')).body.data[0];
    const b = client(app, (await registerUser(app)).cookie);
    const foreign = await b.post(`/api/reminders/${mine.id}/dismiss`);
    const missing = await b.post(`/api/reminders/${NONEXISTENT}/dismiss`);
    const malformed = await b.post('/api/reminders/not-a-uuid/dismiss');
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(malformed.body).toEqual(missing.body);
    expect((await remindersOf(pool, userId)).find((r) => r.id === mine.id)!.read_at).toBeNull(); // untouched
  });

  it('requires CSRF and a session', async () => {
    await delivered();
    const id = (await list('channel=in_app&status=sent')).body.data[0].id;
    expect((await request(app).post(`/api/reminders/${id}/dismiss`).set('Cookie', cookie)).status).toBe(403);
    expect((await client(app).post(`/api/reminders/${id}/dismiss`)).status).toBe(401);
  });
});

describe('preferences (reminder settings)', () => {
  it('GET returns the signed-in user’s settings', async () => {
    const res = await api.get('/api/preferences');
    expect(res.body.data).toEqual({
      currency: 'INR', theme: 'dark', timezone: 'Asia/Kolkata', reminderLeadDays: 3, reminderHour: 9, inAppReminders: true,
      emailRemindersEnabled: false, trialRemindersEnabled: true,
    });
  });

  it('PATCH updates only the fields given and returns the new settings', async () => {
    const res = await api.patch('/api/preferences', { reminderLeadDays: 7, emailRemindersEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ reminderLeadDays: 7, emailRemindersEnabled: true, reminderHour: 9, inAppReminders: true, timezone: 'Asia/Kolkata', theme: 'dark' });
  });

  it('PATCH takes effect immediately on existing reminders: the new lead time replaces the pending ones', async () => {
    await createSub(app, cookie, { nextBillingDate: '2030-02-01' });
    await runSchedulerCycle(env);
    const before = await remindersOf(pool, userId);
    expect(before).toMatchObject([{ lead_days: 3, status: 'pending' }]);
    await api.patch('/api/preferences', { reminderLeadDays: 7 }).expect(200);
    const after = await remindersOf(pool, userId);
    expect(after.find((r) => r.lead_days === 7)).toMatchObject({ status: 'pending' });
    expect(after.find((r) => r.lead_days === 3)).toMatchObject({ status: 'superseded' });
    await api.patch('/api/preferences', { reminderHour: 18 }).expect(200);
    expect((await remindersOf(pool, userId)).find((r) => r.status === 'pending')!.remind_at.toISOString()).toBe('2030-01-25T12:30:00.000Z'); // 18:00 IST, 7 days before Feb 1
  });

  it('turning email on records an honest email row even when email cannot be delivered', async () => {
    await createSub(app, cookie, { nextBillingDate: '2030-02-01' });
    await api.patch('/api/preferences', { emailRemindersEnabled: true }).expect(200);
    expect((await remindersOf(pool, userId)).map((r) => [r.channel, r.status])).toEqual([['email', 'pending'], ['in_app', 'pending']]);
    mailer.configured = false;
    clock.set('2030-01-29T04:00:00Z');
    await runSchedulerCycle(env);
    expect((await remindersOf(pool, userId)).find((r) => r.channel === 'email')).toMatchObject({ status: 'skipped', skip_reason: 'smtp_not_configured' });
  });

  it.each<[Record<string, unknown>, string]>([
    [{}, 'empty'], [{ reminderLeadDays: 61 }, 'lead too big'], [{ reminderLeadDays: -1 }, 'negative lead'], [{ reminderLeadDays: 2.5 }, 'fractional lead'],
    [{ reminderHour: 24 }, 'hour 24'], [{ reminderHour: '9' }, 'string hour'], [{ inAppReminders: 'yes' }, 'string boolean'],
    [{ theme: 'light' }, 'theme (Stage 8)'], [{ timezone: 'UTC' }, 'timezone (Stage 8)'], [{ currency: 'USD' }, 'currency (Stage 8)'], [{ userId: 'x' }, 'userId'], [{ id: 'x' }, 'id'],
  ])('rejects %j (%s)', async (body) => {
    const res = await api.patch('/api/preferences', body);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect((await api.get('/api/preferences')).body.data.reminderLeadDays).toBe(3); // nothing changed
  });

  it('accepts the boundaries (lead 0 and 60, hour 0 and 23)', async () => {
    expect((await api.patch('/api/preferences', { reminderLeadDays: 0, reminderHour: 0 })).status).toBe(200);
    expect((await api.patch('/api/preferences', { reminderLeadDays: 60, reminderHour: 23 })).status).toBe(200);
  });

  it('only ever changes the signed-in user’s own row', async () => {
    const b = await registerUser(app);
    await api.patch('/api/preferences', { reminderLeadDays: 9, inAppReminders: false }).expect(200);
    expect((await client(app, b.cookie).get('/api/preferences')).body.data).toMatchObject({ reminderLeadDays: 3, inAppReminders: true });
  });

  it('requires CSRF and a session', async () => {
    expect((await request(app).patch('/api/preferences').set('Cookie', cookie).send({ reminderLeadDays: 5 })).status).toBe(403);
    expect((await client(app).patch('/api/preferences', { reminderLeadDays: 5 })).status).toBe(401);
    expect((await client(app).get('/api/preferences')).status).toBe(401);
  });
});
