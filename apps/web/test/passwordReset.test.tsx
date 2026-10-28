import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeServer, SESSION, fail, freezeTime, ok, page, renderApp } from './helpers';

beforeEach(() => freezeTime());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const GOOD = 'Correct-Horse-9-battery';

const anonServer = () =>
  new FakeServer().on('GET', '/api/auth/me', fail(401, 'UNAUTHENTICATED', 'Authentication required.')).on('GET', '/api/subscriptions', page([])).install();

/** The reset page reads the token from the URL fragment, then strips it (the real address bar is checked in the browser suite). */
const openReset = (hash = `#token=${TOKEN}`) => renderApp(`/reset-password${hash}`);

describe('forgot password: asking for a link', () => {
  it('the sign-in page links to it', async () => {
    anonServer();
    const { user } = renderApp('/login');
    await user.click(await screen.findByRole('link', { name: 'Forgot your password?' }));
    expect(await screen.findByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
  });

  it('sends exactly the address (with the CSRF header) and then says the same thing for every address', async () => {
    const server = anonServer().on('POST', '/api/auth/password-reset/request', ok({ requested: true }));
    const { user } = renderApp('/forgot-password');
    await user.type(await screen.findByLabelText('Email'), '  asha@example.com ');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('If an account exists for asha@example.com, we have sent a link to choose a new password.');
    const call = server.last('POST', '/api/auth/password-reset/request')!;
    expect(call.body).toEqual({ email: 'asha@example.com' });
    expect(call.headers.get('X-SubCycle-Client')).toBe('web');

    await user.click(screen.getByRole('button', { name: 'Use a different address' }));
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });

  it('checks the address in the browser first and sends nothing when it is empty or malformed', async () => {
    const server = anonServer().on('POST', '/api/auth/password-reset/request', ok({ requested: true }));
    const { user } = renderApp('/forgot-password');
    await user.click(await screen.findByRole('button', { name: 'Send reset link' }));
    expect((await screen.findAllByText('Enter your email address.')).length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect((await screen.findAllByText('Enter a valid email address.')).length).toBeGreaterThan(0);
    expect(server.to('POST', '/api/auth/password-reset/request')).toHaveLength(0);
  });

  it('tells the truth when the server has no email provider (no "we sent it")', async () => {
    anonServer().on('POST', '/api/auth/password-reset/request', fail(503, 'EMAIL_NOT_CONFIGURED', "Password reset by email isn't available on this server. Ask the person who runs SubCycle to reset your password."));
    const { user } = renderApp('/forgot-password');
    await user.type(await screen.findByLabelText('Email'), 'asha@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Password reset by email isn't available on this server");
    expect(screen.queryByRole('heading', { name: 'Check your email' })).not.toBeInTheDocument();
  });

  it('shows a rate-limit message and keeps the form usable', async () => {
    anonServer().on('POST', '/api/auth/password-reset/request', fail(429, 'RATE_LIMITED', 'Too many requests. Please try again later.'));
    const { user } = renderApp('/forgot-password');
    await user.type(await screen.findByLabelText('Email'), 'asha@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeEnabled();
  });
});

describe('reset password: choosing a new one', () => {
  it('reads the token from the URL fragment and posts exactly the token and password', async () => {
    const server = anonServer().on('POST', '/api/auth/password-reset/confirm', ok({ reset: true }));
    const { user } = openReset();
    await user.type(await screen.findByLabelText('New password'), GOOD);
    await user.type(screen.getByLabelText('Repeat the new password'), GOOD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('signed out on every device');
    const call = server.last('POST', '/api/auth/password-reset/confirm')!;
    expect(call.body).toEqual({ token: TOKEN, newPassword: GOOD });
    expect(call.headers.get('X-SubCycle-Client')).toBe('web');
    await user.click(screen.getByRole('link', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('refuses a short or mismatching password in the browser and sends nothing', async () => {
    const server = anonServer().on('POST', '/api/auth/password-reset/confirm', ok({ reset: true }));
    const { user } = openReset();
    await user.type(await screen.findByLabelText('New password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect((await screen.findAllByText('Use at least 10 characters.')).length).toBeGreaterThan(0);

    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), GOOD);
    await user.type(screen.getByLabelText('Repeat the new password'), GOOD + 'x');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect((await screen.findAllByText('The two passwords do not match.')).length).toBeGreaterThan(0);
    expect(server.to('POST', '/api/auth/password-reset/confirm')).toHaveLength(0);
  });

  it('shows the server\'s refusal of a weak password against the field and keeps the form (the link is not used up)', async () => {
    anonServer().on('POST', '/api/auth/password-reset/confirm', fail(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [{ path: 'newPassword', message: 'This password is too common. Choose something less guessable.' }]));
    const { user } = openReset();
    await user.type(await screen.findByLabelText('New password'), 'password1234');
    await user.type(screen.getByLabelText('Repeat the new password'), 'password1234');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect((await screen.findAllByText('This password is too common. Choose something less guessable.')).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Link not valid' })).not.toBeInTheDocument();
  });

  it('an invalid or expired link says so and offers a new one', async () => {
    anonServer().on('POST', '/api/auth/password-reset/confirm', fail(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired. Links work once and last an hour.'));
    const { user } = openReset();
    await user.type(await screen.findByLabelText('New password'), GOOD);
    await user.type(screen.getByLabelText('Repeat the new password'), GOOD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('heading', { name: 'Link not valid' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('invalid or has expired');
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password');
  });

  it('without a token in the address it shows a plain explanation instead of a form', async () => {
    anonServer();
    openReset('');
    expect(await screen.findByRole('heading', { name: 'Link not valid' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('needs the link from your password reset email');
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('works even in a browser that is still signed in, and ends that stale session afterwards', async () => {
    let me = 0;
    new FakeServer()
      .on('GET', '/api/auth/me', () => (++me === 1 ? ok(SESSION) : fail(401, 'UNAUTHENTICATED', 'Authentication required.')))
      .on('GET', '/api/subscriptions', page([]))
      .on('POST', '/api/auth/password-reset/confirm', ok({ reset: true }))
      .install();
    const { user } = openReset();
    await user.type(await screen.findByLabelText('New password'), GOOD);
    await user.type(screen.getByLabelText('Repeat the new password'), GOOD);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('heading', { name: 'Password changed' })).toBeInTheDocument();
    await waitFor(() => expect(me).toBeGreaterThan(1)); // the app re-checked the session after the reset
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Sign in' })).toBeInTheDocument();
  });
});
