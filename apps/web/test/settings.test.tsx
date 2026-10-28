import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeServer, SESSION, deferred, emailSession, fail, freezeTime, ok, renderApp, signedInServer } from './helpers';

beforeEach(() => {
  freezeTime();
  document.documentElement.lang = 'en';
  document.documentElement.dataset.theme = 'dark';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Signed-in server whose preferences endpoint behaves like the real one (merges the patch and echoes it). */
function settingsServer(session = SESSION) {
  const prefs = { ...session.preferences };
  const server = signedInServer()
    .on('GET', '/api/auth/me', ok(session))
    .on('PATCH', '/api/preferences', (req) => {
      Object.assign(prefs, req.body as object);
      return ok({ ...prefs });
    });
  return { server, prefs };
}

const open = async () => {
  const utils = renderApp('/settings');
  await screen.findByRole('heading', { name: 'Settings', level: 1 });
  return utils;
};
const card = (name: string | RegExp) => within(screen.getByRole('heading', { name }).closest('section')!);
const writes = (server: FakeServer) => server.calls.filter((c) => c.method !== 'GET');

describe('settings page: appearance and region', () => {
  it('shows the saved values', async () => {
    settingsServer();
    await open();
    const c = card('Region');
    expect(c.queryByRole('radio', { name: 'Light' })).toBeNull(); // the app is dark only: there is no theme choice
    expect(c.getByLabelText('Preferred currency')).toHaveValue('INR');
    expect(c.getByLabelText('Time zone')).toHaveValue('Asia/Kolkata');
  });

  it('saves only what changed and does not touch subscriptions or payments', async () => {
    const { server } = settingsServer();
    const { user } = await open();
    const c = card('Region');
    await user.selectOptions(c.getByLabelText('Time zone'), 'Europe/London');
    await user.click(c.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    expect(server.last('PATCH', '/api/preferences')!.body).toEqual({ timezone: 'Europe/London' });
    expect(writes(server).every((w) => w.path === '/api/preferences')).toBe(true);
  });

  it('currency change sends only the currency; the copy says nothing is converted', async () => {
    const { server } = settingsServer();
    const { user } = await open();
    const c = card('Region');
    expect(c.getByText(/nothing is converted, and different currencies are never added together/)).toBeInTheDocument();
    await user.selectOptions(c.getByLabelText('Preferred currency'), 'USD');
    await user.click(c.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved.');
    expect(server.last('PATCH', '/api/preferences')!.body).toEqual({ currency: 'USD' });
    expect(server.calls.some((x) => x.path.startsWith('/api/subscriptions') && x.method !== 'GET')).toBe(false);
  });

  it('time-zone change sends only the zone, refetches data that depends on "today", and keeps the alias selectable', async () => {
    const { server } = settingsServer({ ...SESSION, preferences: { ...SESSION.preferences, timezone: 'Asia/Calcutta' } });
    const { user } = await open();
    const c = card('Region');
    expect(c.getByLabelText('Time zone')).toHaveValue('Asia/Calcutta');
    await user.selectOptions(c.getByLabelText('Time zone'), 'Pacific/Kiritimati');
    expect(c.getByText(/Right now it is .* there\./)).toBeInTheDocument();
    await user.click(c.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved.');
    expect(server.last('PATCH', '/api/preferences')!.body).toEqual({ timezone: 'Pacific/Kiritimati' });
  });

  it('saving without a change sends nothing', async () => {
    const { server } = settingsServer();
    const { user } = await open();
    await user.click(card('Region').getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('You haven’t changed anything yet.')).toBeInTheDocument();
    expect(writes(server)).toHaveLength(0);
  });

  it('a server-side validation error is shown against the field and nothing is applied', async () => {
    const { server } = settingsServer();
    server.on('PATCH', '/api/preferences', fail(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [{ path: 'timezone', message: 'Choose a valid time zone, such as Asia/Kolkata.' }]));
    const { user } = await open();
    const c = card('Region');
    await user.selectOptions(c.getByLabelText('Time zone'), 'Europe/London');
    await user.click(c.getByRole('button', { name: 'Save settings' }));
    expect((await screen.findAllByText('Choose a valid time zone, such as Asia/Kolkata.')).length).toBeGreaterThan(0);
    expect(document.documentElement.dataset.theme).toBe('dark'); // not applied: the save failed
  });

  it('a network failure is shown and can be retried', async () => {
    const { server } = settingsServer();
    server.on('PATCH', '/api/preferences', fail(500, 'INTERNAL_ERROR', 'Something went wrong.'));
    const { user } = await open();
    const c = card('Region');
    await user.selectOptions(c.getByLabelText('Time zone'), 'Europe/London');
    await user.click(c.getByRole('button', { name: 'Save settings' }));
    expect((await screen.findAllByText('Something went wrong.')).length).toBeGreaterThan(0);
    server.on('PATCH', '/api/preferences', ok({ ...SESSION.preferences, timezone: 'Europe/London' }));
    await user.click(c.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
  });

  it('the app is always dark: an old saved light or system theme is ignored, on every route and after signing out', async () => {
    settingsServer({ ...SESSION, preferences: { ...SESSION.preferences, theme: 'light' } });
    const { user } = await open();
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(screen.getAllByRole('link', { name: /^Calendar$/ })[0]!);
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(screen.getAllByRole('button', { name: /Sign out/ })[0]!);
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('settings page: reminders and account details', () => {
  it('summarises reminder settings and points to the Reminders page rather than duplicating it', async () => {
    settingsServer();
    await open();
    const c = card('Reminders');
    expect(c.getByText(/3 days before at 09:00 \(Asia\/Kolkata\)/)).toBeInTheDocument();
    expect(c.getByText(/Email reminders are unavailable on this server/)).toBeInTheDocument();
    expect(c.getByRole('link', { name: /Change reminder settings/ })).toHaveAttribute('href', '/reminders');
  });

  it('shows the email address and verification status truthfully', async () => {
    settingsServer(emailSession(true));
    await open();
    expect(card('Account').getByText('asha@example.com')).toBeInTheDocument();
    expect(card('Account').getByText(/Verified\. The email address can’t be changed/)).toBeInTheDocument();
  });

  it('unverified with email available links to verification; without a provider it says why verification is unavailable', async () => {
    settingsServer(emailSession(false));
    const first = await open();
    expect(card('Account').getByRole('link', { name: 'Verify it on the Reminders page' })).toHaveAttribute('href', '/reminders');
    first.unmount();
    settingsServer();
    await open();
    expect(card('Account').getByText(/Verification is unavailable because this server has no email provider/)).toBeInTheDocument();
  });

  it('renames the account and shows the new name in the shell', async () => {
    const { server } = settingsServer();
    server.on('PATCH', '/api/account', (req) => ok({ user: { ...SESSION.user, displayName: (req.body as { displayName: string }).displayName } }));
    const { user } = await open();
    const name = card('Account').getByLabelText('Name');
    await user.clear(name);
    await user.type(name, '  Asha R.  ');
    await user.click(card('Account').getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Name updated.')).toBeInTheDocument();
    expect(server.last('PATCH', '/api/account')!.body).toEqual({ displayName: 'Asha R.' });
    expect(screen.getAllByText('Asha R.').length).toBeGreaterThan(0);
  });

  it('rejects an empty name without a request', async () => {
    const { server } = settingsServer();
    const { user } = await open();
    await user.clear(card('Account').getByLabelText('Name'));
    await user.click(card('Account').getByRole('button', { name: 'Save name' }));
    expect((await screen.findAllByText('Enter a name.')).length).toBeGreaterThan(0);
    expect(writes(server)).toHaveLength(0);
  });
});

describe('settings page: change password', () => {
  const fill = async (user: Awaited<ReturnType<typeof open>>['user'], cur: string, next: string, again = next) => {
    const c = card('Change password');
    if (cur) await user.type(c.getByLabelText('Current password'), cur);
    if (next) await user.type(c.getByLabelText('New password'), next);
    if (again) await user.type(c.getByLabelText('Repeat the new password'), again);
    await user.click(c.getByRole('button', { name: 'Change password' }));
  };

  it('uses the right autocomplete hints and password inputs', async () => {
    settingsServer();
    await open();
    const c = card('Change password');
    expect(c.getByLabelText('Current password')).toHaveAttribute('autocomplete', 'current-password');
    expect(c.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');
    expect(c.getByLabelText('New password')).toHaveAttribute('type', 'password');
  });

  it.each([
    ['', 'Another-Long-Pass-1', /Enter your current password/],
    ['Old-Password-123', 'short', /at least 10 characters/],
    ['Old-Password-123', 'Old-Password-123', /different from your current one/],
  ])('validates locally (%j -> %j) and sends nothing', async (cur, next, message) => {
    const { server } = settingsServer();
    const { user } = await open();
    await fill(user, cur, next);
    expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
    expect(writes(server)).toHaveLength(0);
  });

  it('a mismatched repeat is caught before any request', async () => {
    const { server } = settingsServer();
    const { user } = await open();
    await fill(user, 'Old-Password-123', 'Another-Long-Pass-1', 'Another-Long-Pass-2');
    expect((await screen.findAllByText('The two new passwords don’t match.')).length).toBeGreaterThan(0);
    expect(writes(server)).toHaveLength(0);
  });

  it('a wrong current password shows a field error, keeps the user signed in and keeps what they typed in the other fields', async () => {
    const { server } = settingsServer();
    server.on('POST', '/api/account/password', fail(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [{ path: 'currentPassword', message: 'Your current password is incorrect.' }]));
    const { user } = await open();
    await fill(user, 'wrong-wrong-1', 'Another-Long-Pass-1');
    expect((await screen.findAllByText('Your current password is incorrect.')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(card('Change password').getByLabelText('New password')).toHaveValue('Another-Long-Pass-1');
    expect(card('Change password').getByLabelText('Current password')).toHaveFocus();
  });

  it('server-side policy failures (too common) appear on the new-password field', async () => {
    const { server } = settingsServer();
    server.on('POST', '/api/account/password', fail(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [{ path: 'newPassword', message: 'This password is too common. Choose something less guessable.' }]));
    const { user } = await open();
    await fill(user, 'Old-Password-123', 'password1234');
    expect((await screen.findAllByText(/too common/)).length).toBeGreaterThan(0);
  });

  it('success: one request with exactly the two fields, fields cleared, other sessions reported, still signed in', async () => {
    const { server } = settingsServer();
    server.on('POST', '/api/account/password', ok({ changed: true, otherSessionsSignedOut: 2 }));
    const { user } = await open();
    await fill(user, 'Old-Password-123', 'Another-Long-Pass-1');
    expect(await screen.findByText(/2 other sessions were signed out/)).toBeInTheDocument();
    expect(server.to('POST', '/api/account/password')).toHaveLength(1);
    expect(server.last('POST', '/api/account/password')!.body).toEqual({ currentPassword: 'Old-Password-123', newPassword: 'Another-Long-Pass-1' });
    expect(card('Change password').getByLabelText('Current password')).toHaveValue('');
    expect(card('Change password').getByLabelText('New password')).toHaveValue('');
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(server.to('POST', '/api/auth/logout')).toHaveLength(0);
  });

  it('a double click sends a single request', async () => {
    const { server } = settingsServer();
    const gate = deferred();
    server.on('POST', '/api/account/password', () => gate.promise);
    const { user } = await open();
    const c = card('Change password');
    await user.type(c.getByLabelText('Current password'), 'Old-Password-123');
    await user.type(c.getByLabelText('New password'), 'Another-Long-Pass-1');
    await user.type(c.getByLabelText('Repeat the new password'), 'Another-Long-Pass-1');
    await user.dblClick(c.getByRole('button', { name: 'Change password' }));
    gate.resolve(ok({ changed: true, otherSessionsSignedOut: 0 }));
    await screen.findByText(/No other sessions were signed in/);
    expect(server.to('POST', '/api/account/password')).toHaveLength(1);
  });

  it('too many wrong attempts (429) gives a clear message', async () => {
    const { server } = settingsServer();
    server.on('POST', '/api/account/password', fail(429, 'RATE_LIMITED', 'Too many requests. Please try again later.'));
    const { user } = await open();
    await fill(user, 'Old-Password-123', 'Another-Long-Pass-1');
    expect(await screen.findByText(/Too many incorrect attempts/)).toBeInTheDocument();
  });
});

describe('settings page: delete account', () => {
  const openDialog = async () => {
    const utils = await open();
    await utils.user.click(card('Delete account').getByRole('button', { name: 'Delete account…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete your account permanently?' });
    return { ...utils, dialog: within(dialog) };
  };

  it('explains exactly what happens, including backups and that providers are not cancelled', async () => {
    settingsServer();
    const { dialog } = await openDialog();
    expect(dialog.getByText(/subscriptions, recorded payments, price history, reminders and settings are deleted/)).toBeInTheDocument();
    expect(dialog.getByText(/signed out on every device/)).toBeInTheDocument();
    expect(dialog.getByText(/Nothing is cancelled with any provider/)).toBeInTheDocument();
    expect(dialog.getByText(/Backups kept by whoever runs this server can still hold your data/)).toBeInTheDocument();
  });

  it('focus starts on the password field and the destructive button stays disabled until both are filled correctly', async () => {
    settingsServer();
    const { dialog, user } = await openDialog();
    expect(dialog.getByLabelText('Your password')).toHaveFocus();
    const del = dialog.getByRole('button', { name: 'Delete my account forever' });
    expect(del).toBeDisabled();
    await user.type(dialog.getByLabelText('Your password'), 'Old-Password-123');
    await user.type(dialog.getByLabelText(/Type asha@example.com to confirm/), 'asha@example.co');
    expect(del).toBeDisabled();
    await user.type(dialog.getByLabelText(/Type asha@example.com to confirm/), 'm');
    expect(del).toBeEnabled();
  });

  it('Escape and Cancel close it without any request, and focus returns to the opener', async () => {
    const { server } = settingsServer();
    const { user } = await openDialog();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Delete account…' })).toHaveFocus();
    expect(writes(server)).toHaveLength(0);
  });

  it('a wrong password keeps the dialog open with a field error and the account intact', async () => {
    const { server } = settingsServer();
    server.on('DELETE', '/api/account', fail(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [{ path: 'password', message: 'Your password is incorrect.' }]));
    const { dialog, user } = await openDialog();
    await user.type(dialog.getByLabelText('Your password'), 'nope-nope-nope');
    await user.type(dialog.getByLabelText(/to confirm/), 'asha@example.com');
    await user.click(dialog.getByRole('button', { name: 'Delete my account forever' }));
    expect((await dialog.findAllByText('Your password is incorrect.')).length).toBeGreaterThan(0);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Welcome back' })).not.toBeInTheDocument();
  });

  it('success: one DELETE with the password and email, then the sign-in page with a notice, and NO further request', async () => {
    const { server } = settingsServer();
    server.on('DELETE', '/api/account', { status: 204 });
    const { dialog, user } = await openDialog();
    await user.type(dialog.getByLabelText('Your password'), 'Old-Password-123');
    await user.type(dialog.getByLabelText(/to confirm/), 'ASHA@example.com');
    const before = server.calls.length;
    await user.click(dialog.getByRole('button', { name: 'Delete my account forever' }));
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your account and its data have been permanently deleted.');
    const after = server.calls.slice(before);
    expect(after.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /api/account']); // nothing authenticated afterwards, not even logout or /me
    expect(after[0]!.body).toEqual({ password: 'Old-Password-123', confirmEmail: 'ASHA@example.com' });
    expect(after[0]!.headers.get('X-SubCycle-Client')).toBe('web');
  });

  it('a double submit sends one DELETE and the dialog cannot be dismissed while it runs', async () => {
    const { server } = settingsServer();
    const gate = deferred();
    server.on('DELETE', '/api/account', () => gate.promise);
    const { dialog, user } = await openDialog();
    await user.type(dialog.getByLabelText('Your password'), 'Old-Password-123');
    await user.type(dialog.getByLabelText(/to confirm/), 'asha@example.com');
    await user.dblClick(dialog.getByRole('button', { name: 'Delete my account forever' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    gate.resolve({ status: 204 });
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(server.to('DELETE', '/api/account')).toHaveLength(1);
  });

  it('a rate-limit response is explained', async () => {
    const { server } = settingsServer();
    server.on('DELETE', '/api/account', fail(429, 'RATE_LIMITED', 'Too many requests. Please try again later.'));
    const { dialog, user } = await openDialog();
    await user.type(dialog.getByLabelText('Your password'), 'Old-Password-123');
    await user.type(dialog.getByLabelText(/to confirm/), 'asha@example.com');
    await user.click(dialog.getByRole('button', { name: 'Delete my account forever' }));
    expect((await dialog.findAllByText(/Too many incorrect attempts/)).length).toBeGreaterThan(0);
  });
});

describe('settings navigation and accessibility', () => {
  it('Settings is reachable from the account menu and the sidebar', async () => {
    settingsServer();
    const { user } = renderApp('/');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getAllByRole('link', { name: 'Settings' }).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /Account menu for/ }));
    await user.click(screen.getAllByRole('link', { name: 'Settings' }).find((l) => l.closest('#account-menu'))!);
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
  });

  it('settings page and the open delete dialog have no axe violations', async () => {
    settingsServer(emailSession(false));
    const { user } = await open();
    const run = async (label: string) => {
      const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`), label).toEqual([]);
    };
    await run('settings');
    await user.click(card('Delete account').getByRole('button', { name: 'Delete account…' }));
    await screen.findByRole('dialog');
    await run('delete dialog');
  });
});
