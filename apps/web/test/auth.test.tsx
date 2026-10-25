import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeServer, SESSION, deferred, fail, freezeTime, ok, page, renderApp, signedInServer } from './helpers';

beforeEach(() => freezeTime());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const anonServer = () =>
  new FakeServer().on('GET', '/api/auth/me', fail(401, 'UNAUTHENTICATED', 'Authentication required.')).on('GET', '/api/subscriptions', page([])).install();

describe('unauthenticated navigation', () => {
  it.each(['/', '/subscriptions', '/subscriptions/new', '/subscriptions/abc', '/subscriptions/abc/edit'])('%s redirects to the sign-in page', async (route) => {
    anonServer();
    renderApp(route);
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('after signing in, returns to the page that was requested', async () => {
    const server = anonServer().on('POST', '/api/auth/login', ok(SESSION));
    const { user } = renderApp('/subscriptions');
    await user.type(await screen.findByLabelText('Email'), 'asha@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Subscriptions', level: 1 })).toBeInTheDocument();
    expect(server.to('POST', '/api/auth/login')).toHaveLength(1);
  });

  it('a signed-in user opening the sign-in page is sent on to the app', async () => {
    signedInServer();
    renderApp('/login');
    expect(await screen.findByRole('heading', { name: /Good afternoon, Asha/ })).toBeInTheDocument();
  });

  it('shows a retryable error when the session check cannot reach the server', async () => {
    let attempts = 0;
    new FakeServer()
      .on('GET', '/api/auth/me', () => (++attempts === 1 ? fail(500, 'INTERNAL_ERROR', 'Something went wrong on our side.') : ok(SESSION)))
      .on('GET', '/api/subscriptions', page([]))
      .install();
    const { user } = renderApp('/');
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByRole('heading', { name: /Good afternoon, Asha/ })).toBeInTheDocument();
  });

  it('shows a loading status while the session is checked', async () => {
    const gate = deferred();
    new FakeServer().on('GET', '/api/auth/me', () => gate.promise).install();
    renderApp('/');
    expect(screen.getByRole('status')).toHaveTextContent('Loading SubCycle');
    gate.resolve(fail(401, 'UNAUTHENTICATED', 'x'));
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });
});

describe('sign in', () => {
  it('posts exactly the credentials with the CSRF header and same-origin cookies, then shows the dashboard', async () => {
    const server = anonServer().on('POST', '/api/auth/login', ok(SESSION));
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), '  asha@example.com ');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: /Good afternoon, Asha/ })).toBeInTheDocument();
    const call = server.last('POST', '/api/auth/login')!;
    expect(call.body).toEqual({ email: 'asha@example.com', password: 'correct horse battery' });
    expect(call.headers.get('X-SubCycle-Client')).toBe('web');
    expect(call.credentials).toBe('same-origin');
  });

  it('wrong credentials: a generic message, the form stays usable, and nothing sensitive is shown', async () => {
    anonServer().on('POST', '/api/auth/login', fail(401, 'UNAUTHENTICATED', 'Incorrect email or password.'));
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), 'asha@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong password!!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(screen.getByLabelText('Password')).toHaveValue('wrong password!!'); // not cleared, not echoed elsewhere
  });

  it('validates before sending: empty and malformed input produce field errors and no request', async () => {
    const server = anonServer();
    const { user } = renderApp('/login');
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    const summary = await screen.findByRole('alert');
    expect(within(summary).getByText('Enter your email address.')).toBeInTheDocument();
    expect(within(summary).getByText('Enter your password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveFocus());
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findAllByText('Enter a valid email address.')).length).toBeGreaterThan(0);
    expect(server.to('POST', '/api/auth/login')).toHaveLength(0);
  });

  it('prevents duplicate submissions while the request is in flight', async () => {
    const gate = deferred();
    const server = anonServer().on('POST', '/api/auth/login', () => gate.promise);
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), 'asha@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    const button = screen.getByRole('button', { name: 'Sign in' });
    await user.click(button);
    await user.click(screen.getByRole('button', { name: /Signing in/ }));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();
    gate.resolve(ok(SESSION));
    await screen.findByRole('heading', { name: /Good afternoon/ });
    expect(server.to('POST', '/api/auth/login')).toHaveLength(1);
  });

  it('labels every control and submits from the keyboard alone', async () => {
    const server = anonServer().on('POST', '/api/auth/login', ok(SESSION));
    const { user } = renderApp('/login');
    await screen.findByRole('heading', { name: 'Welcome back' });
    await user.tab(); // email
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus();
    await user.keyboard('asha@example.com');
    await user.tab();
    expect(screen.getByLabelText('Password')).toHaveFocus();
    await user.keyboard('correct horse battery{Enter}');
    await screen.findByRole('heading', { name: /Good afternoon/ });
    expect(server.to('POST', '/api/auth/login')).toHaveLength(1);
  });

  it('a rate-limit response is explained, not hidden', async () => {
    anonServer().on('POST', '/api/auth/login', fail(429, 'RATE_LIMITED', 'Too many requests. Please try again later.'));
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), 'asha@example.com');
    await user.type(screen.getByLabelText('Password'), 'whatever password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
  });
});

describe('register', () => {
  it('enforces the password length before sending anything', async () => {
    const server = anonServer();
    const { user } = renderApp('/register');
    await user.type(await screen.findByLabelText('Name'), 'Asha Rao');
    await user.type(screen.getByLabelText('Email'), 'asha@example.com');
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect((await screen.findAllByText('Use at least 10 characters.')).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    expect(server.to('POST', '/api/auth/register')).toHaveLength(0);
  });

  it('shows a server-side "email already registered" error on the email field', async () => {
    anonServer().on('POST', '/api/auth/register', fail(409, 'EMAIL_TAKEN', 'An account with this email already exists.'));
    const { user } = renderApp('/register');
    await user.type(await screen.findByLabelText('Name'), 'Asha Rao');
    await user.type(screen.getByLabelText('Email'), 'asha@example.com');
    await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    const email = screen.getByLabelText('Email');
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'));
    expect(document.getElementById(email.getAttribute('aria-describedby')!)).toHaveTextContent('An account with this email already exists.');
  });

  it('shows server validation details (e.g. a too-common password) against the right field', async () => {
    anonServer().on('POST', '/api/auth/register', fail(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [{ path: 'password', message: 'This password is too common. Choose something less guessable.' }]));
    const { user } = renderApp('/register');
    await user.type(await screen.findByLabelText('Name'), 'Asha Rao');
    await user.type(screen.getByLabelText('Email'), 'asha@example.com');
    await user.type(screen.getByLabelText('Password'), 'password1234');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect((await screen.findAllByText(/too common/)).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
  });

  it('signs the new user in, and sends their browser time zone so dates match their day', async () => {
    const server = anonServer().on('POST', '/api/auth/register', ok(SESSION));
    const { user } = renderApp('/register');
    await user.type(await screen.findByLabelText('Name'), 'Asha Rao');
    await user.type(screen.getByLabelText('Email'), 'asha@example.com');
    await user.type(screen.getByLabelText('Password'), 'a long enough passphrase');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { name: /Good afternoon, Asha/ })).toBeInTheDocument();
    expect(server.last('POST', '/api/auth/register')!.body).toEqual({
      email: 'asha@example.com', password: 'a long enough passphrase', displayName: 'Asha Rao', timezone: expect.stringMatching(/^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+)*$/),
    });
  });
});

describe('sign out and expired sessions', () => {
  it('signing out calls the server, returns to sign-in, and protects the app again', async () => {
    const server = signedInServer().on('POST', '/api/auth/logout', { status: 204 });
    const { user } = renderApp('/');
    await screen.findByRole('heading', { name: /Good afternoon/ });
    await user.click(screen.getAllByRole('button', { name: /Sign out/ })[0]!);
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(server.to('POST', '/api/auth/logout')).toHaveLength(1);
    expect(server.last('POST', '/api/auth/logout')!.headers.get('X-SubCycle-Client')).toBe('web');
  });

  it('even if the server cannot be reached, this browser ends up signed out', async () => {
    signedInServer().on('POST', '/api/auth/logout', fail(500, 'INTERNAL_ERROR', 'Something went wrong.'));
    const { user } = renderApp('/');
    await screen.findByRole('heading', { name: /Good afternoon/ });
    await user.click(screen.getAllByRole('button', { name: /Sign out/ })[0]!);
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });

  it('a 401 mid-session returns to sign-in with a plain notice and exposes no server details', async () => {
    let expired = false;
    new FakeServer()
      .on('GET', '/api/auth/me', ok(SESSION))
      .on('GET', '/api/subscriptions', () => (expired ? fail(401, 'UNAUTHENTICATED', 'Authentication required.') : page([])))
      .install();
    const { user } = renderApp('/');
    await screen.findByRole('heading', { name: /Good afternoon/ });
    expired = true;
    await user.click(screen.getAllByRole('link', { name: /Subscriptions/ })[0]!);
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Your session has ended. Please sign in again.');
    expect(document.body).not.toHaveTextContent('Authentication required.');
    expect(document.body).not.toHaveTextContent('UNAUTHENTICATED');
  });
});

describe('credentials never touch web storage', () => {
  it('after signing in and using the app, localStorage and sessionStorage are empty and no auth header was sent', async () => {
    const server = anonServer().on('POST', '/api/auth/login', ok(SESSION));
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), 'asha@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: /Good afternoon/ });
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    for (const call of server.calls) {
      expect(call.headers.get('Authorization')).toBeNull();
      expect(call.credentials).toBe('same-origin');
    }
  });
});
