import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { classifySendError, deliverDueReminders, reconcileAllReminders, reconcileUserReminders } from '../src/services/reminders.js';
import {
  FakeMailer, T0, captureLogs, client, createCtx, createSub, networkError, registerUser, remindersOf, resetDb, setPrefs, smtpError, userIdOf, verifyEmail,
} from './helpers.js';

const mailer = new FakeMailer();
const ctx = createCtx({ mailer });
const { pool, clock, env, app } = ctx;
let userId: string;
let email: string;
let cookie: string;
let api: ReturnType<typeof client>;

const MIN = 60_000;
const at = (iso: string) => clock.set(iso);

beforeEach(async () => {
  await resetDb(pool);
  at(T0); // 2030-01-15T10:00Z = 15:30 in Asia/Kolkata
  Object.assign(mailer, { sent: [], errors: [], attempts: 0, failNext: false, configured: true, onSend: undefined });
  const reg = await registerUser(app);
  userId = userIdOf(reg.res);
  email = reg.email;
  cookie = reg.cookie;
  api = client(app, cookie);
});
afterAll(() => pool.end());

const reconcile = () => reconcileUserReminders(env, userId);
const deliver = () => deliverDueReminders(env);
const rows = () => remindersOf(pool, userId);
const count = async (t: string) => (await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n as number;
const mk = (o: Record<string, unknown> = {}) => createSub(app, cookie, o); // monthly, next 2030-02-01
// 2030-02-01 with lead 3 at 09:00 IST is due from this instant:
const DUE = '2030-01-29T03:30:00.000Z';

describe('generation', () => {
  it('plans one in-app reminder per upcoming renewal, at the right instant, and is idempotent', async () => {
    const s = await mk();
    const first = await reconcile();
    expect(first).toMatchObject({ created: 1, superseded: 0, expiredMissed: 0, invalidTimeZone: false });
    const [r] = await rows();
    expect(r).toMatchObject({ subscription_id: s.id, kind: 'renewal', channel: 'in_app', target_date: '2030-02-01', lead_days: 3, status: 'pending', attempts: 0 });
    expect(r!.remind_at.toISOString()).toBe(DUE);
    const again = await reconcile();
    expect(again).toMatchObject({ created: 0, superseded: 0, rescheduled: 0, revived: 0 });
    expect(await rows()).toHaveLength(1);
  });

  it('the unique constraint is the last line of defence against duplicates', async () => {
    const s = await mk();
    await reconcile();
    await expect(
      pool.query(`INSERT INTO reminders (user_id, subscription_id, kind, channel, target_date, lead_days, remind_at) VALUES ($1,$2,'renewal','in_app','2030-02-01',3,now())`, [userId, s.id]),
    ).rejects.toThrow(/reminders_unique_per_renewal/);
  });

  it('CONCURRENT generation yields exactly one row per reminder', async () => {
    await mk();
    await mk({ name: 'Spotify', nextBillingDate: '2030-02-10' });
    await setPrefs(pool, userId, { email_reminders_enabled: true });
    const results = await Promise.all(Array.from({ length: 8 }, () => reconcile()));
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(4); // 2 subscriptions x 2 channels
    expect(await rows()).toHaveLength(4);
    expect(new Set((await rows()).map((r) => `${r.subscription_id}|${r.channel}|${r.target_date}`)).size).toBe(4);
  });

  it('creates an email row too when email reminders are on, even though email may not be deliverable (delivery records why)', async () => {
    await mk();
    await setPrefs(pool, userId, { email_reminders_enabled: true });
    await reconcile();
    expect((await rows()).map((r) => r.channel)).toEqual(['email', 'in_app']);
    await setPrefs(pool, userId, { in_app_reminders: false });
    await reconcile();
    const after = await rows();
    expect(after.find((r) => r.channel === 'in_app')!.status).toBe('superseded');
    expect(after.find((r) => r.channel === 'email')!.status).toBe('pending');
  });

  it('weekly subscriptions get a reminder for each renewal in the horizon; trials get a trial-end reminder', async () => {
    const weekly = await mk({ billingFrequency: 'weekly', anchorDate: '2030-01-17', nextBillingDate: '2030-01-17' });
    const trial = await mk({ name: 'Trial', status: 'trial', trialEndDate: '2030-01-25', nextBillingDate: '2030-01-25' });
    await reconcile();
    const rs = await rows();
    expect(rs.filter((r) => r.subscription_id === weekly.id).map((r) => r.target_date).slice(0, 3)).toEqual(['2030-01-17', '2030-01-24', '2030-01-31']);
    expect(rs.filter((r) => r.subscription_id === trial.id)).toMatchObject([{ kind: 'trial_end', target_date: '2030-01-25' }]);
  });

  it('never touches payments or subscriptions', async () => {
    const s = await mk();
    const before = (await pool.query('SELECT * FROM subscriptions WHERE id = $1', [s.id])).rows[0];
    await reconcile();
    await deliver();
    expect(await count('payments')).toBe(0);
    expect((await pool.query('SELECT * FROM subscriptions WHERE id = $1', [s.id])).rows[0]).toEqual(before);
  });

  describe('keeps pending reminders in line with the schedule (supersede / reschedule / revive)', () => {
    const statusOf = async () => (await rows()).map((r) => r.status);

    it.each([
      ['pause', 'pause'], ['cancel', 'cancel'], ['archive', 'archive'],
    ])('a subscription that is %sd no longer has a pending reminder', async (_n, action) => {
      const s = await mk();
      await reconcile();
      await api.post(`/api/subscriptions/${s.id}/status`, { action }).expect(200);
      expect(await reconcile()).toMatchObject({ superseded: 1 });
      expect(await statusOf()).toEqual(['superseded']);
    });

    it('deleting a subscription removes its reminders (cascade)', async () => {
      const s = await mk();
      await reconcile();
      await api.del(`/api/subscriptions/${s.id}`).expect(204);
      expect(await rows()).toEqual([]);
    });

    it('turning reminders off for one subscription supersedes only that one', async () => {
      const a = await mk();
      const b = await mk({ name: 'B' });
      await reconcile();
      await api.patch(`/api/subscriptions/${a.id}`, { remindersEnabled: false }).expect(200);
      await reconcile();
      const rs = await rows();
      expect(rs.find((r) => r.subscription_id === a.id)!.status).toBe('superseded');
      expect(rs.find((r) => r.subscription_id === b.id)!.status).toBe('pending');
    });

    it('a changed lead time replaces the reminder; changing it back REVIVES the original row instead of duplicating it', async () => {
      const s = await mk();
      await reconcile();
      const original = (await rows())[0]!;
      await api.patch(`/api/subscriptions/${s.id}`, { reminderLeadDays: 7 }).expect(200);
      expect(await reconcile()).toMatchObject({ created: 1, superseded: 1 });
      let rs = await rows();
      expect(rs.map((r) => [r.lead_days, r.status])).toEqual(expect.arrayContaining([[3, 'superseded'], [7, 'pending']]));
      await api.patch(`/api/subscriptions/${s.id}`, { reminderLeadDays: null }).expect(200); // back to the default of 3
      expect(await reconcile()).toMatchObject({ revived: 1, superseded: 1 });
      rs = await rows();
      expect(rs).toHaveLength(2);
      expect(rs.find((r) => r.id === original.id)!.status).toBe('pending');
    });

    it('a renewal that was paid ahead (date advanced past it) no longer has a pending reminder', async () => {
      const s = await mk();
      await reconcile();
      await api.post(`/api/subscriptions/${s.id}/payments`, { amountMinor: 64900, forBillingDate: '2030-02-01', advanceNextBillingDate: true }).expect(201);
      await reconcile();
      expect((await rows()).find((r) => r.target_date === '2030-02-01')!.status).toBe('superseded');
    });

    it('converting a trial replaces its trial-end reminder with renewal reminders', async () => {
      const t = await mk({ status: 'trial', trialEndDate: '2030-01-25', nextBillingDate: '2030-01-25' });
      await reconcile();
      await api.post(`/api/subscriptions/${t.id}/status`, { action: 'convert' }).expect(200);
      await reconcile();
      const rs = await rows();
      expect(rs.find((r) => r.kind === 'trial_end')!.status).toBe('superseded');
      expect(rs.find((r) => r.kind === 'renewal')!.status).toBe('pending');
    });

    it('a new reminder hour or time zone RESCHEDULES the pending row (same row, new instant)', async () => {
      await mk();
      await reconcile();
      const id = (await rows())[0]!.id;
      await setPrefs(pool, userId, { reminder_hour: 18 });
      expect(await reconcile()).toMatchObject({ rescheduled: 1, created: 0, superseded: 0 });
      const [r] = await rows();
      expect(r!.id).toBe(id);
      expect(r!.remind_at.toISOString()).toBe('2030-01-29T12:30:00.000Z'); // 18:00 IST
      await setPrefs(pool, userId, { timezone: 'America/Los_Angeles' });
      await reconcile();
      expect((await rows())[0]!.remind_at.toISOString()).toBe('2030-01-30T02:00:00.000Z'); // 18:00 PST
      expect(await rows()).toHaveLength(1);
    });

    it('delivered reminders are history: they are never altered or recreated', async () => {
      await mk();
      await reconcile();
      at(DUE);
      await deliver();
      const [sent] = await rows();
      expect(sent).toMatchObject({ status: 'sent', target_date: '2030-02-01' });
      await setPrefs(pool, userId, { reminder_lead_days: 5, reminder_hour: 20 }); // settings change after the fact
      await reconcile();
      const feb1 = (await rows()).filter((r) => r.target_date === '2030-02-01');
      expect(feb1).toHaveLength(1); // not recreated under the new lead time either (it is already past its reminder window)
      expect(feb1[0]).toEqual(sent);
    });
  });

  it('a pending reminder whose renewal date has PASSED is recorded as missed, not superseded, not sent', async () => {
    await mk();
    await reconcile();
    at('2030-02-05T04:00:00Z'); // the process was down: the Feb 1 renewal came and went
    const r = await reconcile();
    expect(r.expiredMissed).toBe(1);
    const first = (await rows()).find((x) => x.target_date === '2030-02-01')!;
    expect(first).toMatchObject({ status: 'skipped', skip_reason: 'delivery_window_missed', sent_at: null });
    expect(mailer.sent).toHaveLength(0);
  });

  describe('unusable time zones', () => {
    it('are reported, create nothing, and do not throw', async () => {
      await mk();
      await setPrefs(pool, userId, { timezone: 'Mars/Olympus' });
      expect(await reconcile()).toMatchObject({ invalidTimeZone: true, created: 0 });
      expect(await rows()).toEqual([]);
    });
    it('one user with a bad zone does not stop another user', async () => {
      await mk();
      await setPrefs(pool, userId, { timezone: 'Mars/Olympus' });
      const other = await registerUser(app);
      const otherId = userIdOf(other.res);
      await createSub(app, other.cookie);
      const total = await reconcileAllReminders(env);
      expect(total.usersWithInvalidTimeZone).toBe(1);
      expect(total.created).toBe(1);
      expect(await remindersOf(pool, otherId)).toHaveLength(1);
    });
  });

  it('is scoped per user: reconciling one user never changes another’s reminders', async () => {
    await mk();
    const other = await registerUser(app);
    const otherId = userIdOf(other.res);
    const theirs = await createSub(app, other.cookie, { name: 'Theirs' });
    await reconcileUserReminders(env, otherId);
    const before = await remindersOf(pool, otherId);
    await reconcile();
    await setPrefs(pool, userId, { reminder_hour: 20 });
    await reconcile();
    expect(await remindersOf(pool, otherId)).toEqual(before);
    expect(before[0]!.subscription_id).toBe(theirs.id);
  });

  it('email reminders skipped only for lack of email delivery are revived once email works (and still before their date)', async () => {
    await mk();
    await setPrefs(pool, userId, { email_reminders_enabled: true });
    mailer.configured = false;
    await reconcile();
    at(DUE);
    await deliver();
    expect((await rows()).find((r) => r.channel === 'email')).toMatchObject({ status: 'skipped', skip_reason: 'smtp_not_configured' });
    mailer.configured = true;
    await verifyEmail(pool, userId);
    expect(await reconcile()).toMatchObject({ revived: 1 });
    expect((await rows()).find((r) => r.channel === 'email')).toMatchObject({ status: 'pending', skip_reason: null, attempts: 0 });
    await deliver();
    expect((await rows()).find((r) => r.channel === 'email')!.status).toBe('sent');
    expect(mailer.sent).toHaveLength(1);
  });
});

describe('delivery', () => {
  const setupDue = async (over: Record<string, unknown> = {}) => {
    const s = await mk(over);
    await reconcile();
    at(DUE);
    return s;
  };
  const emailUser = async () => {
    await setPrefs(pool, userId, { email_reminders_enabled: true, in_app_reminders: false });
    await verifyEmail(pool, userId);
  };

  describe('in-app', () => {
    it('is marked sent (visible) only once due, with the injected clock as sent_at, and exactly once', async () => {
      await mk();
      await reconcile();
      at('2030-01-29T03:29:59Z');
      expect(await deliver()).toMatchObject({ claimed: 0 }); // one second early
      expect((await rows())[0]!.status).toBe('pending');
      at(DUE);
      expect(await deliver()).toMatchObject({ claimed: 1, inAppSent: 1 });
      const [r] = await rows();
      expect(r).toMatchObject({ status: 'sent', skip_reason: null, read_at: null });
      expect(r!.sent_at!.toISOString()).toBe(DUE);
      expect(await deliver()).toMatchObject({ claimed: 0 });
    });
    it('does not deliver to a user whose in-app reminders were switched off after planning', async () => {
      await setupDue();
      await setPrefs(pool, userId, { in_app_reminders: false });
      expect(await deliver()).toMatchObject({ superseded: 1, inAppSent: 0 });
      expect((await rows())[0]!.status).toBe('superseded');
    });
  });

  describe('email: every precondition is checked and every outcome is recorded truthfully', () => {
    it('no SMTP provider configured -> skipped with a reason, never sent', async () => {
      await emailUser();
      mailer.configured = false;
      await setupDue();
      expect(await deliver()).toMatchObject({ emailSkipped: 1, emailSent: 0 });
      expect((await rows())[0]).toMatchObject({ status: 'skipped', skip_reason: 'smtp_not_configured', sent_at: null });
      expect(mailer.attempts).toBe(0);
    });
    it('unverified address -> skipped with a reason, nothing is sent to it', async () => {
      await setPrefs(pool, userId, { email_reminders_enabled: true, in_app_reminders: false }); // not verified
      await setupDue();
      await deliver();
      expect((await rows())[0]).toMatchObject({ status: 'skipped', skip_reason: 'email_not_verified' });
      expect(mailer.attempts).toBe(0);
    });
    it('email switched off after planning -> skipped(email_disabled)', async () => {
      await emailUser();
      await setupDue();
      await setPrefs(pool, userId, { email_reminders_enabled: false });
      await deliver();
      expect((await rows())[0]).toMatchObject({ status: 'skipped', skip_reason: 'email_disabled' });
      expect(mailer.attempts).toBe(0);
    });
    it('configured + verified + enabled -> sent exactly once, to the account address, with schedule-only content', async () => {
      await emailUser();
      await setupDue({ notes: 'SECRET-NOTE-TEXT', paymentMethodLabel: 'SECRET-CARD-LABEL', name: 'Netflix' });
      expect(await deliver()).toMatchObject({ emailSent: 1 });
      expect(mailer.sent).toHaveLength(1);
      const m = mailer.sent[0]!;
      expect(m.to).toBe(email);
      expect(m.subject).toBe('SubCycle: Netflix renews in 3 days');
      expect(m.text).toContain('2030-02-01');
      expect(m.text).toContain('649.00 INR');
      expect(m.text).toMatch(/SubCycle can't do that for you/);
      expect(m.text).not.toContain('SECRET-NOTE-TEXT');
      expect(m.text).not.toContain('SECRET-CARD-LABEL');
      expect((await rows())[0]).toMatchObject({ status: 'sent', last_error: null });
      expect(await deliver()).toMatchObject({ claimed: 0 });
      expect(mailer.sent).toHaveLength(1); // a second pass never re-sends
    });
    it('a trial-end email says SubCycle cannot cancel or convert', async () => {
      await emailUser();
      await mk({ status: 'trial', trialEndDate: '2030-01-25', nextBillingDate: '2030-01-25', name: 'Hotstar' });
      await reconcile();
      at('2030-01-22T04:00:00Z');
      await deliver();
      expect(mailer.sent[0]!.subject).toBe('SubCycle: your Hotstar trial ends in 3 days');
      expect(mailer.sent[0]!.text).toMatch(/can't cancel or convert/);
    });
  });

  describe('failures and retries', () => {
    beforeEach(emailUser);

    it('a temporary SMTP failure keeps it pending, schedules a retry with backoff, and records only a safe label', async () => {
      await setupDue();
      mailer.errors = [smtpError(421)];
      expect(await deliver()).toMatchObject({ retryScheduled: 1, emailSent: 0, emailFailed: 0 });
      const [r] = await rows();
      expect(r).toMatchObject({ status: 'pending', attempts: 1, last_error: 'SMTP 421', sent_at: null });
      expect(r!.next_attempt_at!.getTime()).toBe(new Date(DUE).getTime() + 5 * MIN);
      expect(r!.last_error).not.toMatch(/secret|example\.com/i); // provider text never reaches the database
    });
    it('is not retried before the backoff elapses, then succeeds exactly once', async () => {
      await setupDue();
      mailer.errors = [smtpError(451)];
      await deliver();
      at(new Date(new Date(DUE).getTime() + 4 * MIN).toISOString());
      expect(await deliver()).toMatchObject({ claimed: 0 });
      expect(mailer.attempts).toBe(1);
      at(new Date(new Date(DUE).getTime() + 5 * MIN).toISOString());
      expect(await deliver()).toMatchObject({ emailSent: 1 });
      expect(mailer.attempts).toBe(2);
      expect(mailer.sent).toHaveLength(1);
      expect((await rows())[0]).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
    });
    it('backoff grows 5 / 30 / 120 / 360 minutes, and the fifth failure marks it failed', async () => {
      await setupDue();
      mailer.errors = Array.from({ length: 5 }, () => smtpError(421));
      let now = new Date(DUE).getTime();
      for (const wait of [5, 30, 120, 360]) {
        await deliver();
        const [r] = await rows();
        expect(r!.status).toBe('pending');
        expect(r!.next_attempt_at!.getTime() - now).toBe(wait * MIN);
        now = r!.next_attempt_at!.getTime();
        at(new Date(now).toISOString());
      }
      expect(await deliver()).toMatchObject({ emailFailed: 1 });
      expect((await rows())[0]).toMatchObject({ status: 'failed', attempts: 5, last_error: 'SMTP 421', next_attempt_at: null });
      expect(await deliver()).toMatchObject({ claimed: 0 }); // failed is final
      expect(mailer.sent).toHaveLength(0);
    });
    it('a permanent failure (5xx) is final immediately', async () => {
      await setupDue();
      mailer.errors = [smtpError(550)];
      expect(await deliver()).toMatchObject({ emailFailed: 1, retryScheduled: 0 });
      expect((await rows())[0]).toMatchObject({ status: 'failed', attempts: 1, last_error: 'SMTP 550' });
      expect(mailer.attempts).toBe(1);
    });
    it('network-level errors are retried, labelled with their code only', async () => {
      await setupDue();
      mailer.errors = [networkError('ETIMEDOUT')];
      await deliver();
      expect((await rows())[0]).toMatchObject({ status: 'pending', last_error: 'SMTP ETIMEDOUT' });
    });
    it('an error code with unexpected text is reduced to a generic label (nothing arbitrary is stored)', () => {
      expect(classifySendError(Object.assign(new Error('x'), { code: 'weird text user@example.com' }))).toEqual({ permanent: false, label: 'SMTP error' });
      expect(classifySendError(new Error('plain'))).toEqual({ permanent: false, label: 'SMTP error' });
      expect(classifySendError(smtpError(554))).toEqual({ permanent: true, label: 'SMTP 554' });
      expect(classifySendError(smtpError(450))).toEqual({ permanent: false, label: 'SMTP 450' });
    });
    it('a reminder that keeps failing past its renewal date is recorded as missed, never delivered late', async () => {
      await setupDue();
      mailer.errors = [smtpError(421)];
      await deliver();
      at('2030-02-02T04:00:00Z'); // renewal date (Feb 1) has passed
      expect(await deliver()).toMatchObject({ missed: 1, emailSent: 0 });
      expect((await rows())[0]).toMatchObject({ status: 'skipped', skip_reason: 'delivery_window_missed' });
      expect(mailer.sent).toHaveLength(0);
    });
    it('a subscription paused after planning gets no email (superseded)', async () => {
      const s = await setupDue();
      await pool.query("UPDATE subscriptions SET status = 'paused' WHERE id = $1", [s.id]);
      expect(await deliver()).toMatchObject({ superseded: 1 });
      expect(mailer.attempts).toBe(0);
    });
    it('an unusable time zone at delivery time is recorded, not guessed', async () => {
      await setupDue();
      await setPrefs(pool, userId, { timezone: 'Mars/Olympus' });
      expect(await deliver()).toMatchObject({ invalidTimeZone: 1 });
      expect((await rows())[0]).toMatchObject({ status: 'skipped', skip_reason: 'invalid_time_zone' });
    });
  });

  describe('concurrency and the crash window', () => {
    beforeEach(emailUser);

    it('two workers delivering at once: the claim lease means exactly ONE email is sent', async () => {
      await setupDue();
      mailer.onSend = () => new Promise((r) => setTimeout(r, 150)); // hold the send open while the second worker runs
      const [a, b] = await Promise.all([deliver(), deliver()]);
      expect(mailer.sent).toHaveLength(1);
      expect(a.emailSent + b.emailSent).toBe(1);
      expect(a.claimed + b.claimed).toBe(1);
      expect((await rows())[0]!.status).toBe('sent');
    });

    it('many due reminders are split between concurrent workers with no duplicates and none lost', async () => {
      for (let i = 0; i < 12; i++) await mk({ name: `S${i}` });
      await reconcile();
      at(DUE);
      const results = await Promise.all([deliver(), deliver(), deliver()]);
      expect(results.reduce((n, r) => n + r.emailSent, 0)).toBe(12);
      expect(mailer.sent).toHaveLength(12);
      expect(new Set(mailer.sent.map((m) => m.subject)).size).toBe(12);
    });

    it('DOCUMENTED LIMIT: if the process dies after the provider accepted a message but before it was recorded, it is re-sent after the lease expires (at-least-once)', async () => {
      await setupDue();
      // Make recording "sent" fail, as a crash right after the provider's acceptance would.
      await pool.query(`CREATE OR REPLACE FUNCTION test_block_sent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'sent' THEN RAISE EXCEPTION 'simulated crash'; END IF; RETURN NEW; END $$`);
      await pool.query('CREATE TRIGGER test_block_sent BEFORE UPDATE ON reminders FOR EACH ROW EXECUTE FUNCTION test_block_sent()');
      try {
        const first = await deliver();
        expect(first.errors).toBe(1);
        expect(mailer.sent).toHaveLength(1);
        expect((await rows())[0]!.status).toBe('pending'); // honest: not recorded as sent
        expect(await deliver()).toMatchObject({ claimed: 0 }); // leased: no immediate duplicate
        expect(mailer.sent).toHaveLength(1);
      } finally {
        await pool.query('DROP TRIGGER test_block_sent ON reminders');
        await pool.query('DROP FUNCTION test_block_sent()');
      }
      at(new Date(new Date(DUE).getTime() + 10 * MIN).toISOString()); // lease (10 min) expires
      expect(await deliver()).toMatchObject({ emailSent: 1 });
      expect(mailer.sent).toHaveLength(2); // the duplicate the documentation warns about
      expect((await rows())[0]!.status).toBe('sent');
      expect(await deliver()).toMatchObject({ claimed: 0 }); // and it stops there
    });

    it('a stuck claim (worker died mid-send) does not block the reminder forever', async () => {
      await setupDue();
      await pool.query("UPDATE reminders SET attempts = 1, next_attempt_at = $1", [new Date(new Date(DUE).getTime() + 10 * MIN)]);
      expect(await deliver()).toMatchObject({ claimed: 0 });
      at(new Date(new Date(DUE).getTime() + 10 * MIN).toISOString());
      expect(await deliver()).toMatchObject({ emailSent: 1 });
    });
  });

  describe('logging', () => {
    it('never contains addresses, provider text, subscription names, notes or message bodies', async () => {
      const logs = captureLogs();
      const logged = { ...env, logger: logs.logger };
      await emailUser();
      await setupDue({ name: 'TopSecretServiceName', notes: 'TOP-SECRET-NOTE' });
      mailer.errors = [smtpError(421), smtpError(550)];
      await deliverDueReminders(logged);
      at(new Date(new Date(DUE).getTime() + 5 * MIN).toISOString());
      await deliverDueReminders(logged);
      const text = logs.text();
      expect(logs.events().some((e) => e.event === 'reminder_email_failed')).toBe(true);
      for (const secret of [email, 'secret-provider-text', 'TopSecretServiceName', 'TOP-SECRET-NOTE', 'Open it in SubCycle']) expect(text).not.toContain(secret);
    });
  });
});

