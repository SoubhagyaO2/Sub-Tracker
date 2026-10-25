import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReminderDto } from '@subcycle/shared';
import { deferred, emailSession, fail, freezeTime, makeReminder, makeSub, ok, page, renderApp, SESSION, signedInServer } from './helpers';

beforeEach(() => freezeTime());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const meta = (total: number, unread = 0) => ({ page: 1, pageSize: 25, total, unread });

/** Serves a reminder list honouring the channel / status filters the way the real API does. */
function remindersServer(all: ReminderDto[], session = SESSION) {
  const state = { all: [...all] };
  const server = signedInServer()
    .on('GET', '/api/auth/me', ok(session))
    .on('GET', '/api/reminders', (req) => {
      const channel = req.query.get('channel');
      const status = req.query.get('status')?.split(',');
      const items = state.all.filter((r) => (!channel || r.channel === channel) && (!status || status.includes(r.status)));
      return ok(items, meta(items.length, state.all.filter((r) => r.channel === 'in_app' && r.status === 'sent' && !r.readAt).length));
    })
    .on('POST', '/api/reminders/:id/dismiss', (_req, p) => {
      const r = state.all.find((x) => x.id === p.id);
      if (!r) return fail(404, 'NOT_FOUND', 'Not found.');
      r.readAt = '2030-01-15T10:00:00.000Z';
      return ok(r);
    });
  return { server, state };
}

async function openPage() {
  const utils = renderApp('/reminders');
  await screen.findByRole('heading', { name: 'Reminders', level: 1 });
  return utils;
}

const inbox = () => within(screen.getByRole('heading', { name: 'Inbox' }).closest('section')!);
const log = () => within(screen.getByRole('heading', { name: 'Delivery log' }).closest('section')!);
const settings = () => within(screen.getByRole('heading', { name: 'Reminder settings' }).closest('section')!);

describe('reminders: inbox', () => {
  it('lists delivered in-app reminders as New and marks one read', async () => {
    const r = makeReminder({ id: 'r-a' });
    const { server } = remindersServer([r]);
    const { user } = await openPage();
    await screen.findByText('New');
    expect(inbox().getByText(/Netflix renews/)).toBeInTheDocument();
    expect(inbox().getByText(/3 days before/)).toBeInTheDocument();
    await user.click(inbox().getByRole('button', { name: 'Mark the reminder for Netflix as read' }));
    await waitFor(() => expect(inbox().queryByText('New')).not.toBeInTheDocument());
    expect(server.to('POST', '/api/reminders/r-a/dismiss')).toHaveLength(1);
    expect(server.last('POST', '/api/reminders/r-a/dismiss')!.headers.get('X-SubCycle-Client')).toBe('web');
    expect(inbox().queryByRole('button', { name: /Mark the reminder/ })).not.toBeInTheDocument();
  });

  it('the inbox only requests delivered in-app reminders', async () => {
    const { server } = remindersServer([makeReminder()]);
    await openPage();
    await screen.findByText('New');
    const inboxCall = server.to('GET', '/api/reminders').find((c) => c.query.get('channel') === 'in_app' && c.query.get('status') === 'sent');
    expect(inboxCall).toBeDefined();
  });

  it('trial reminders read as a trial ending, never a charge', async () => {
    remindersServer([makeReminder({ kind: 'trial_end', subscriptionName: 'Free trial' })]);
    await openPage();
    expect((await screen.findAllByText(/Free trial free trial ends/)).length).toBeGreaterThan(0);
  });

  it('empty state explains when reminders appear', async () => {
    remindersServer([]);
    await openPage();
    expect(await screen.findByText('No reminders yet')).toBeInTheDocument();
  });

  it('a failed dismissal shows an error and keeps the reminder unread', async () => {
    const { server } = remindersServer([makeReminder({ id: 'r-b' })]);
    server.on('POST', '/api/reminders/:id/dismiss', fail(500, 'INTERNAL_ERROR', 'Something went wrong.'));
    const { user } = await openPage();
    await user.click(await screen.findByRole('button', { name: /Mark the reminder for Netflix as read/ }));
    expect(await screen.findByText('Something went wrong.')).toBeInTheDocument();
    expect(inbox().getByText('New')).toBeInTheDocument();
  });

  it('shows loading, then an error with Retry', async () => {
    const gate = deferred();
    const { server } = remindersServer([]);
    server.on('GET', '/api/reminders', () => gate.promise);
    await openPage();
    expect((await screen.findAllByRole('status', { name: /Loading (reminders|delivery log)/ })).length).toBeGreaterThan(0);
    gate.resolve(fail(500, 'INTERNAL_ERROR', 'Something went wrong.'));
    expect(await screen.findByText('We couldn’t load your reminders')).toBeInTheDocument();
    expect(await screen.findByText('We couldn’t load the delivery log')).toBeInTheDocument();
  });
});

describe('reminders: delivery log tells the truth', () => {
  it('skipped email reminders show the specific reason, and are never shown as sent', async () => {
    remindersServer([
      makeReminder({ id: 'e1', channel: 'email', status: 'skipped', skipReason: 'smtp_not_configured', sentAt: null, attempts: 0 }),
      makeReminder({ id: 'e2', channel: 'email', status: 'skipped', skipReason: 'email_not_verified', sentAt: null, attempts: 0 }),
      makeReminder({ id: 'e3', channel: 'email', status: 'skipped', skipReason: 'delivery_window_missed', sentAt: null, attempts: 0 }),
    ]);
    await openPage();
    await screen.findByText(/This server has no email provider configured/);
    expect(log().getByText(/Your email address isn’t verified/)).toBeInTheDocument();
    expect(log().getByText(/wasn’t sent late/)).toBeInTheDocument();
    expect(log().getAllByText('Skipped')).toHaveLength(3);
    expect(log().queryByText('Sent')).not.toBeInTheDocument();
    expect(log().getAllByText(/Not sent:/)).toHaveLength(3);
  });

  it('a sent email says "accepted by the email server", not "delivered"', async () => {
    remindersServer([makeReminder({ id: 'e1', channel: 'email', status: 'sent' })]);
    await openPage();
    expect(await log().findByText(/Accepted by the email server/)).toHaveTextContent(/can’t see whether it reached your inbox/);
  });

  it('pending retries and permanent failures are distinguished and show only the safe error label', async () => {
    remindersServer([
      makeReminder({ id: 'p1', channel: 'email', status: 'pending', attempts: 2, lastError: 'SMTP 421', sentAt: null }),
      makeReminder({ id: 'f1', channel: 'email', status: 'failed', attempts: 5, lastError: 'SMTP 550', sentAt: null }),
    ]);
    await openPage();
    expect(await log().findByText(/Couldn’t be sent yet \(SMTP 421\)\. SubCycle will try again automatically/)).toBeInTheDocument();
    expect(log().getByText(/Couldn’t be sent \(SMTP 550\)\. SubCycle stopped trying/)).toBeInTheDocument();
    expect(log().getByText('Scheduled')).toBeInTheDocument();
    expect(log().getByText('Failed')).toBeInTheDocument();
  });

  it('the channel filter re-requests with that channel', async () => {
    const { server } = remindersServer([makeReminder({ channel: 'email', status: 'skipped', skipReason: 'email_disabled', sentAt: null })]);
    const { user } = await openPage();
    await screen.findByText(/Email reminders were turned off/);
    await user.selectOptions(log().getByLabelText('Show'), 'email');
    await waitFor(() => expect(server.calls.some((c) => c.path === '/api/reminders' && c.query.get('channel') === 'email' && !c.query.get('status'))).toBe(true));
  });

  it('an empty log says nothing has been planned', async () => {
    remindersServer([]);
    await openPage();
    expect(await log().findByText(/Nothing has been planned yet/)).toBeInTheDocument();
  });
});

describe('reminders: settings and email availability', () => {
  it('unconfigured email: explains it, disables the toggle, offers no verify button', async () => {
    remindersServer([]);
    await openPage();
    expect(await screen.findByText(/Email reminders aren’t available on this server/)).toBeInTheDocument();
    expect(settings().getByLabelText('Also email me')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Send verification email/ })).not.toBeInTheDocument();
  });

  it('configured but unverified: offers to send a verification email; the toggle stays disabled', async () => {
    const { server } = remindersServer([], emailSession(false));
    server.on('POST', '/api/account/email-verification', ok({ sent: true }));
    const { user } = await openPage();
    expect(settings().getByLabelText('Also email me')).toBeDisabled();
    await user.click(await screen.findByRole('button', { name: 'Send verification email' }));
    expect(await screen.findByText(/Verification email sent to asha@example\.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send it again' })).toBeInTheDocument();
    expect(settings().getByLabelText('Also email me')).toBeDisabled();
  });

  it.each([
    [429, 'RATE_LIMITED', 'Please wait a minute before asking for another email.'],
    [503, 'EMAIL_UNAVAILABLE', 'Email isn’t available right now.'],
  ])('verification request failing with %i shows the server message and does not claim it was sent', async (status, code, message) => {
    const { server } = remindersServer([], emailSession(false));
    server.on('POST', '/api/account/email-verification', fail(status, code, message));
    const { user } = await openPage();
    await user.click(await screen.findByRole('button', { name: 'Send verification email' }));
    expect(await screen.findByRole('alert', {}, { timeout: 2000 })).toHaveTextContent(message);
    expect(screen.queryByText(/Verification email sent/)).not.toBeInTheDocument();
  });

  it('verified: the toggle is enabled and the verified address is named', async () => {
    remindersServer([], emailSession(true));
    await openPage();
    expect(await screen.findByText(/asha@example\.com is verified/)).toBeInTheDocument();
    expect(settings().getByLabelText('Also email me')).toBeEnabled();
  });

  it('saves only what changed, then reflects the saved values', async () => {
    const { server } = remindersServer([], emailSession(true));
    server.on('PATCH', '/api/preferences', (req) => ok({ ...emailSession(true).preferences, ...(req.body as object) }));
    const { user } = await openPage();
    const lead = await settings().findByLabelText(/Remind me this many days before/);
    await user.clear(lead);
    await user.type(lead, '7');
    await user.click(settings().getByLabelText('Also email me'));
    await user.click(settings().getByRole('button', { name: 'Save reminder settings' }));
    expect(await screen.findByText('Reminder settings saved.')).toBeInTheDocument();
    const call = server.last('PATCH', '/api/preferences')!;
    expect(call.body).toEqual({ reminderLeadDays: 7, emailRemindersEnabled: true });
    expect(call.headers.get('X-SubCycle-Client')).toBe('web');
  });

  it('saving with no changes sends nothing', async () => {
    const { server } = remindersServer([]);
    const { user } = await openPage();
    await user.click(await settings().findByRole('button', { name: 'Save reminder settings' }));
    expect(await screen.findByText('You haven’t changed anything yet.')).toBeInTheDocument();
    expect(server.to('PATCH', '/api/preferences')).toHaveLength(0);
  });

  it.each(['', '61', '-1', '2.5', 'abc'])('rejects lead time %j before any request', async (value) => {
    const { server } = remindersServer([]);
    const { user } = await openPage();
    const lead = await settings().findByLabelText(/Remind me this many days before/);
    await user.clear(lead);
    if (value) await user.type(lead, value);
    await user.click(settings().getByRole('button', { name: 'Save reminder settings' }));
    expect((await screen.findAllByText('Enter a whole number of days from 0 to 60.')).length).toBeGreaterThan(0);
    expect(server.to('PATCH', '/api/preferences')).toHaveLength(0);
  });

  it('a server-side validation error is shown against the field', async () => {
    const { server } = remindersServer([]);
    server.on('PATCH', '/api/preferences', fail(422, 'VALIDATION_ERROR', 'Invalid input.', [{ path: 'reminderLeadDays', message: 'Must be at most 60.' }]));
    const { user } = await openPage();
    const lead = await settings().findByLabelText(/Remind me this many days before/);
    await user.clear(lead);
    await user.type(lead, '9');
    await user.click(settings().getByRole('button', { name: 'Save reminder settings' }));
    expect((await screen.findAllByText('Must be at most 60.')).length).toBeGreaterThan(0);
  });
});

describe('verify-email landing page', () => {
  it('submits the token exactly once and confirms; works without a session', async () => {
    const server = new (await import('./helpers')).FakeServer()
      .on('GET', '/api/auth/me', fail(401, 'UNAUTHENTICATED', 'x'))
      .on('POST', '/api/account/email-verification/confirm', ok({ verified: true }))
      .install();
    renderApp('/verify-email?token=abc123');
    expect(await screen.findByText(/Your email address is verified/)).toBeInTheDocument();
    expect(server.to('POST', '/api/account/email-verification/confirm')).toHaveLength(1);
    expect((server.last('POST', '/api/account/email-verification/confirm')!.body as { token: string }).token).toBe('abc123');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('an invalid or expired token says so and offers a way forward', async () => {
    new (await import('./helpers')).FakeServer()
      .on('GET', '/api/auth/me', fail(401, 'UNAUTHENTICATED', 'x'))
      .on('POST', '/api/account/email-verification/confirm', fail(400, 'INVALID_TOKEN', 'bad'))
      .install();
    renderApp('/verify-email?token=nope');
    expect(await screen.findByText(/invalid or has expired/)).toBeInTheDocument();
    expect(screen.queryByText(/Your email address is verified/)).not.toBeInTheDocument();
  });

  it('a missing token makes no request', async () => {
    const server = signedInServer();
    renderApp('/verify-email');
    expect(await screen.findByText(/needs the link from your verification email/)).toBeInTheDocument();
    expect(server.to('POST', /verification/)).toHaveLength(0);
  });

  it('a signed-in user is sent back to reminder settings and their session is refreshed', async () => {
    const server = signedInServer().on('POST', '/api/account/email-verification/confirm', ok({ verified: true }));
    renderApp('/verify-email?token=ok1');
    expect(await screen.findByRole('link', { name: 'Go to reminder settings' })).toHaveAttribute('href', '/reminders');
    await waitFor(() => expect(server.to('GET', '/api/auth/me').length).toBeGreaterThanOrEqual(2));
  });
});

describe('navigation shows the unread count', () => {
  it('the Reminders link carries an unread badge with an accessible name', async () => {
    signedInServer().on('GET', '/api/reminders', ok([makeReminder()], meta(1, 4))).on('GET', '/api/subscriptions', page([makeSub()], 1, 1, 100));
    renderApp('/');
    const links = await screen.findAllByRole('link', { name: /Reminders.*4|4.*unread/i });
    expect(links.length).toBeGreaterThan(0);
  });

  it('no badge when nothing is unread', async () => {
    signedInServer();
    renderApp('/');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('link', { name: /unread/i })).not.toBeInTheDocument();
  });
});
