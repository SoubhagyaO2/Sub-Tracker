import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULER_LOCK_KEY, withAdvisoryLock } from '../src/scheduler/lock.js';
import { runSchedulerCycle } from '../src/scheduler/cycle.js';
import { startScheduler } from '../src/scheduler/index.js';
import { FakeMailer, T0, captureLogs, createCtx, createSub, registerUser, remindersOf, resetDb, setPrefs, userIdOf, verifyEmail, withFailingTrigger } from './helpers.js';
import { TEST_DB_URL } from './dbUrl.js';

const logs = captureLogs();
const mailer = new FakeMailer();
const ctx = createCtx({ mailer, logger: logs.logger });
const { app, pool, clock, env } = ctx;
let userId: string;
let cookie: string;

const at = (iso: string) => clock.set(iso);

beforeEach(async () => {
  await resetDb(pool);
  at(T0);
  logs.lines.length = 0;
  Object.assign(mailer, { sent: [], errors: [], attempts: 0, failNext: false, configured: true, onSend: undefined });
  const reg = await registerUser(app);
  userId = userIdOf(reg.res);
  cookie = reg.cookie;
});
afterAll(() => pool.end());

const count = async (t: string) => (await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n as number;
const subRow = async (id: string) => (await pool.query('SELECT next_billing_date::text AS next, anchor_date::text AS anchor, status FROM subscriptions WHERE id = $1', [id])).rows[0];
const cycleEvents = () => logs.events().filter((e) => e.event === 'scheduler_cycle');

describe('one cycle', () => {
  it('rolls dates forward, plans reminders, delivers what is due, and logs counts only', async () => {
    const stale = await createSub(app, cookie, { nextBillingDate: '2030-01-15' }); // due today...
    at('2030-01-20T10:00:00Z'); // ...and 5 days later it is stale
    const r = await runSchedulerCycle(env);
    expect(r).toMatchObject({ status: 'ran', failedTasks: [], rolledForward: 1 });
    expect(r.reminders.created).toBeGreaterThanOrEqual(1);
    expect((await subRow(stale.id)).next).toBe('2030-02-15');
    expect((await subRow(stale.id)).anchor).toBe('2030-01-15'); // roll-forward never touches the anchor
    const [ev] = cycleEvents();
    expect(ev).toMatchObject({ event: 'scheduler_cycle', status: 'ran', rolledForward: 1 });
    expect(typeof ev!.durationMs).toBe('number');
  });

  it('a second cycle with no time passing changes nothing (idempotent)', async () => {
    await createSub(app, cookie);
    await runSchedulerCycle(env);
    const before = await remindersOf(pool, userId);
    const r = await runSchedulerCycle(env);
    expect(r).toMatchObject({ rolledForward: 0, reminders: { created: 0, superseded: 0, rescheduled: 0, revived: 0, expiredMissed: 0 }, delivery: { claimed: 0 } });
    expect(await remindersOf(pool, userId)).toEqual(before);
  });

  it('NEVER creates a payment, however long the process was away: a passed renewal date is not a payment', async () => {
    const s = await createSub(app, cookie);
    await runSchedulerCycle(env);
    for (const when of ['2030-02-05T10:00:00Z', '2030-03-20T10:00:00Z', '2030-08-01T10:00:00Z', '2031-02-01T10:00:00Z']) {
      at(when);
      await runSchedulerCycle(env);
    }
    expect(await count('payments')).toBe(0);
    expect(await count('subscription_price_history')).toBe(0);
    expect((await subRow(s.id)).status).toBe('active'); // and status is never inferred from a missed date either
    expect((await subRow(s.id)).anchor).toBe('2030-02-01');
  });

  it('processes every user and isolates a user with an unusable time zone', async () => {
    await createSub(app, cookie);
    await setPrefs(pool, userId, { timezone: 'Mars/Olympus' });
    const other = await registerUser(app);
    await createSub(app, other.cookie);
    const r = await runSchedulerCycle(env);
    expect(r.reminders).toMatchObject({ users: 2, usersWithInvalidTimeZone: 1, created: 1 });
    expect(await remindersOf(pool, userIdOf(other.res))).toHaveLength(1);
    expect(r.failedTasks).toEqual([]);
  });

  it('a failing task does not stop the others, and the log carries error names/codes, never row data', async () => {
    await createSub(app, cookie, { nextBillingDate: '2030-01-15' });
    at('2030-01-20T10:00:00Z');
    const r = await withFailingTrigger(pool, 'subscriptions', 'UPDATE', () => runSchedulerCycle(env)); // roll-forward cannot write
    expect(r.failedTasks).toContain('roll_forward');
    expect(r.failedTasks).not.toContain('reconcile_reminders');
    expect(r.failedTasks).not.toContain('deliver_reminders');
    const failure = logs.events().find((e) => e.event === 'scheduler_task_failed')!;
    expect(failure).toMatchObject({ task: 'roll_forward', errorName: 'error' });
    expect(Object.keys(failure).sort()).toEqual(['errorCode', 'errorName', 'event', 'hostname', 'level', 'msg', 'pid', 'task', 'time'].filter((k) => k in failure).sort());
    // the lock was released despite the failure: the next cycle runs and succeeds
    expect(await runSchedulerCycle(env)).toMatchObject({ status: 'ran', failedTasks: [], rolledForward: 1 });
  });
});

describe('overlapping executions', () => {
  it('a cycle that finds another one running skips immediately and does nothing', async () => {
    const holder = new pg.Client({ connectionString: TEST_DB_URL });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [SCHEDULER_LOCK_KEY]); // "another API instance" is mid-cycle
    try {
      await createSub(app, cookie, { nextBillingDate: '2030-01-15' });
      at('2030-01-20T10:00:00Z');
      const r = await runSchedulerCycle(env);
      expect(r.status).toBe('skipped_locked');
      expect(await remindersOf(pool, userId)).toEqual([]); // nothing happened
      expect(logs.events().some((e) => e.event === 'scheduler_cycle_skipped')).toBe(true);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY]);
      await holder.end();
    }
    expect(await runSchedulerCycle(env)).toMatchObject({ status: 'ran', rolledForward: 1 }); // the lock really was released
  });

  it('two cycles at once: while the first is mid-delivery (holding the lock) the second is skipped, and nothing is duplicated', async () => {
    await createSub(app, cookie);
    await setPrefs(pool, userId, { email_reminders_enabled: true, in_app_reminders: false });
    await verifyEmail(pool, userId);
    at('2030-01-29T04:00:00Z'); // the reminder is due the moment it is planned
    let release!: () => void;
    mailer.onSend = () => new Promise<void>((resolve) => (release = resolve));
    const first = runSchedulerCycle(env);
    await vi.waitFor(() => expect(mailer.attempts).toBe(1)); // the first cycle is inside the email send, holding the lock
    const second = await runSchedulerCycle(env);
    expect(second.status).toBe('skipped_locked');
    expect(mailer.attempts).toBe(1); // the skipped cycle did not try to send
    release();
    expect((await first).status).toBe('ran');
    expect(mailer.sent).toHaveLength(1);
    const rows = await remindersOf(pool, userId);
    expect(new Set(rows.map((r) => `${r.subscription_id}|${r.channel}|${r.target_date}|${r.lead_days}`)).size).toBe(rows.length);
    expect(rows.find((r) => r.channel === 'email')!.status).toBe('sent');
  });

  it('withAdvisoryLock: a crashed holder cannot wedge it (the lock dies with its connection)', async () => {
    const holder = new pg.Client({ connectionString: TEST_DB_URL });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [SCHEDULER_LOCK_KEY]);
    expect(await withAdvisoryLock(pool, SCHEDULER_LOCK_KEY, async () => 1)).toEqual({ acquired: false });
    await holder.end(); // the process "dies": PostgreSQL releases the lock
    await vi.waitFor(async () => expect(await withAdvisoryLock(pool, SCHEDULER_LOCK_KEY, async () => 'ran')).toEqual({ acquired: true, value: 'ran' }));
  });

  it('withAdvisoryLock releases the lock when the work throws', async () => {
    await expect(withAdvisoryLock(pool, SCHEDULER_LOCK_KEY, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withAdvisoryLock(pool, SCHEDULER_LOCK_KEY, async () => 'again')).toEqual({ acquired: true, value: 'again' });
  });

});

describe('restart and downtime', () => {
  it('after being down past the reminder time but BEFORE the renewal, the reminder is delivered late (still useful)', async () => {
    await createSub(app, cookie); // renews 2030-02-01, reminder due 2030-01-29 09:00 IST
    await runSchedulerCycle(env); // planned while the process was up
    at('2030-01-31T10:00:00Z'); // ...then the process was down for two weeks and now restarts
    const r = await runSchedulerCycle(env);
    expect(r.delivery.inAppSent).toBe(1);
    expect((await remindersOf(pool, userId)).find((x) => x.target_date === '2030-02-01')).toMatchObject({ status: 'sent', skip_reason: null });
  });

  it('after being down PAST the renewal date, the reminder is recorded as missed (never sent late), the date is rolled forward, and nothing is paid', async () => {
    const s = await createSub(app, cookie);
    await runSchedulerCycle(env);
    at('2030-02-10T10:00:00Z'); // the renewal (Feb 1) came and went while the process was down
    const r = await runSchedulerCycle(env);
    expect(r).toMatchObject({ rolledForward: 1, reminders: { expiredMissed: 1 }, delivery: { inAppSent: 0 } });
    const rs = await remindersOf(pool, userId);
    expect(rs.find((x) => x.target_date === '2030-02-01')).toMatchObject({ status: 'skipped', skip_reason: 'delivery_window_missed', sent_at: null });
    expect(rs.find((x) => x.target_date === '2030-03-01')).toMatchObject({ status: 'pending' }); // the next renewal is planned normally
    expect((await subRow(s.id)).next).toBe('2030-03-01');
    expect(await count('payments')).toBe(0);
  });

  it('a restart in the middle of work loses nothing: a second cycle completes whatever the first did not', async () => {
    for (let i = 0; i < 5; i++) await createSub(app, cookie, { name: `S${i}` });
    await runSchedulerCycle(env);
    at('2030-01-29T04:00:00Z');
    // simulate a cycle that died after planning but before delivering anything
    await pool.query("UPDATE reminders SET next_attempt_at = NULL");
    const r = await runSchedulerCycle(env);
    expect(r.delivery.inAppSent).toBe(5);
    expect((await remindersOf(pool, userId)).filter((x) => x.status === 'sent')).toHaveLength(5);
    expect((await runSchedulerCycle(env)).delivery.claimed).toBe(0);
  });

  it('missed email reminders are recorded as missed too, and no email is sent late', async () => {
    await createSub(app, cookie);
    await setPrefs(pool, userId, { email_reminders_enabled: true, in_app_reminders: false });
    await verifyEmail(pool, userId);
    await runSchedulerCycle(env);
    at('2030-02-03T10:00:00Z');
    await runSchedulerCycle(env);
    expect((await remindersOf(pool, userId)).find((x) => x.target_date === '2030-02-01')).toMatchObject({ channel: 'email', status: 'skipped', skip_reason: 'delivery_window_missed' });
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('startScheduler lifecycle', () => {
  it('runs a cycle immediately on start (restart catch-up), then repeats on its own interval', async () => {
    await createSub(app, cookie, { nextBillingDate: '2030-01-15' });
    at('2030-01-20T10:00:00Z');
    const handle = startScheduler(env, { intervalMs: 60 });
    try {
      await vi.waitFor(() => expect(cycleEvents().length).toBeGreaterThanOrEqual(3), { timeout: 5000 });
      expect((await subRow((await pool.query('SELECT id FROM subscriptions')).rows[0].id)).next).toBe('2030-02-15'); // the first cycle rolled it forward
    } finally {
      await handle.stop();
    }
  });

  it('cycles never overlap, even when one takes longer than the interval', async () => {
    await createSub(app, cookie);
    await setPrefs(pool, userId, { email_reminders_enabled: true, in_app_reminders: false });
    await verifyEmail(pool, userId);
    at('2030-01-29T04:00:00Z');
    let active = 0;
    let maxActive = 0;
    mailer.onSend = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 150));
      active--;
    };
    const handle = startScheduler(env, { intervalMs: 20 });
    try {
      await vi.waitFor(() => expect(cycleEvents().length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    } finally {
      await handle.stop();
    }
    expect(maxActive).toBe(1);
    expect(mailer.sent).toHaveLength(1); // delivered once across all those cycles
  });

  it('stop() waits for an in-flight cycle and no further cycle starts afterwards', async () => {
    await createSub(app, cookie);
    await setPrefs(pool, userId, { email_reminders_enabled: true, in_app_reminders: false });
    await verifyEmail(pool, userId);
    at('2030-01-29T04:00:00Z');
    mailer.onSend = () => new Promise((r) => setTimeout(r, 200));
    const handle = startScheduler(env, { intervalMs: 30 });
    await vi.waitFor(() => expect(mailer.attempts).toBe(1)); // a cycle is in the middle of sending
    await handle.stop(); // must not return until that cycle is done
    expect((await remindersOf(pool, userId)).find((r) => r.channel === 'email')!.status).toBe('sent');
    const settled = cycleEvents().length;
    await new Promise((r) => setTimeout(r, 150));
    expect(cycleEvents().length).toBe(settled);
  });

  it('runNow while another cycle is running is rejected by the lock, not queued', async () => {
    const handle = startScheduler(env, { intervalMs: 60_000, runOnStart: false });
    try {
      const holder = new pg.Client({ connectionString: TEST_DB_URL });
      await holder.connect();
      await holder.query('SELECT pg_advisory_lock($1)', [SCHEDULER_LOCK_KEY]);
      expect((await handle.runNow()).status).toBe('skipped_locked');
      await holder.end();
      await vi.waitFor(async () => expect((await handle.runNow()).status).toBe('ran'));
    } finally {
      await handle.stop();
    }
  });
});

describe('logging', () => {
  it('a full cycle with users, notes and email never logs addresses, names, notes or message text', async () => {
    const secret = await createSub(app, cookie, { name: 'TopSecretName', notes: 'TOP-SECRET-NOTE', paymentMethodLabel: 'TOP-SECRET-CARD' });
    await setPrefs(pool, userId, { email_reminders_enabled: true });
    await verifyEmail(pool, userId);
    mailer.errors = [Object.assign(new Error('550 mailbox user@example.com rejected: secret-provider-text'), { responseCode: 550 })];
    at('2030-01-29T04:00:00Z');
    await runSchedulerCycle(env);
    const text = logs.text();
    expect(text).toContain('scheduler_cycle');
    for (const s of ['TopSecretName', 'TOP-SECRET-NOTE', 'TOP-SECRET-CARD', 'secret-provider-text', 'user@example.com', 'Open it in SubCycle', secret.id]) expect(text).not.toContain(s);
    expect(text).not.toMatch(/@example\.com/);
  });
});

