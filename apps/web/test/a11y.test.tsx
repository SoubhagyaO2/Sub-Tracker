import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeServer, deferred, detailServer, fail, freezeTime, emailSession, estCategory, estTop, makeAnalytics, makeHistory, makePayment, makeReminder, makeSub, ok, page, renderApp, signedInServer } from './helpers';

beforeEach(() => {
  freezeTime();
  document.documentElement.lang = 'en'; // index.html sets this; jsdom starts without it
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Runs axe on the whole document. Colour contrast is excluded because jsdom has no layout/styles; contrast is
 * covered by the token table in docs/DESIGN_SYSTEM.md (computed ratios), not by this test.
 */
async function expectAccessible(label: string) {
  const results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(summary, `${label} has accessibility violations`).toEqual([]);
}

const anon = () => new FakeServer().on('GET', '/api/auth/me', fail(401, 'UNAUTHENTICATED', 'x')).install();
const richSubs = [
  makeSub({ id: 'a', name: 'Netflix', category: 'video', cancellationUrl: 'https://www.netflix.com/cancel' }),
  makeSub({ id: 'b', name: 'Spotify', category: 'music', amountMinor: 11900, icon: { kind: 'emoji', value: '🎵' } }),
  makeSub({ id: 'c', name: 'iCloud', category: 'cloud_storage', amountMinor: 1000, currency: 'USD' }),
  makeSub({ id: 'd', name: 'Free trial', status: 'trial', trialEndDate: '2030-01-20', nextBillingDate: '2030-01-20', effectiveNextBillingDate: '2030-01-20' }),
  makeSub({ id: 'e', name: 'Gym', status: 'paused', effectiveNextBillingDate: null }),
];

describe('automated accessibility checks (axe-core)', () => {
  it('sign in', async () => {
    anon();
    renderApp('/login');
    await screen.findByRole('heading', { name: 'Welcome back' });
    await expectAccessible('login');
  });

  it('sign in with errors showing', async () => {
    anon();
    const { user } = renderApp('/login');
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');
    await expectAccessible('login errors');
  });

  it('register', async () => {
    anon();
    renderApp('/register');
    await screen.findByRole('heading', { name: 'Create your account' });
    await expectAccessible('register');
  });

  it('dashboard with data (several currencies, charts, renewals, trials)', async () => {
    signedInServer()
      .on('GET', '/api/subscriptions', page(richSubs, richSubs.length, 1, 100))
      .on('GET', '/api/analytics/spending', ok(makeAnalytics([makePayment({ subscriptionId: 'a' })])));
    renderApp('/');
    await screen.findByRole('img', { name: /Recorded payments/ });
    await expectAccessible('dashboard');
  });

  it('dashboard: the chart table view', async () => {
    signedInServer()
      .on('GET', '/api/subscriptions', page(richSubs, richSubs.length, 1, 100))
      .on('GET', '/api/analytics/spending', ok(makeAnalytics([makePayment({ subscriptionId: 'a' })])));
    const { user } = renderApp('/');
    await user.click(await screen.findByRole('button', { name: 'View as table' }));
    await screen.findByRole('table');
    await expectAccessible('dashboard table view');
  });

  it('dashboard empty, loading and error states', async () => {
    signedInServer().on('GET', '/api/subscriptions', page([]));
    const first = renderApp('/');
    await screen.findByText('Nothing tracked yet');
    await expectAccessible('dashboard empty');
    first.unmount();

    const gate = deferred();
    signedInServer().on('GET', '/api/subscriptions', () => gate.promise);
    const second = renderApp('/');
    await screen.findByRole('status', { name: 'Loading your dashboard' });
    await expectAccessible('dashboard loading');
    second.unmount();

    signedInServer().on('GET', '/api/subscriptions', fail(500, 'INTERNAL_ERROR', 'Something went wrong.'));
    renderApp('/');
    await screen.findByRole('alert');
    await expectAccessible('dashboard error');
  });

  it('subscription list (rows, filters, pagination)', async () => {
    signedInServer().on('GET', '/api/subscriptions', page(richSubs, 60, 1, 25));
    renderApp('/subscriptions');
    await screen.findByText('Netflix');
    await expectAccessible('list');
  });

  it('subscription list: empty-with-filters state', async () => {
    signedInServer();
    renderApp('/subscriptions?category=music');
    await screen.findByText('No subscriptions match these filters');
    await expectAccessible('list empty');
  });

  it('subscription detail with payments and price history', async () => {
    detailServer({
      sub: richSubs[0]!,
      payments: [makePayment({ subscriptionId: 'a', note: 'upi' }), makePayment({ subscriptionId: 'a', status: 'refunded', amountMinor: 5000 })],
      history: [makeHistory({ subscriptionId: 'a' })],
      upcoming: [{ date: '2030-02-01', amountMinor: 64900, currency: 'INR' }],
    });
    renderApp('/subscriptions/a');
    await screen.findByRole('heading', { name: 'Netflix', level: 1 });
    await screen.findByText('upi');
    await screen.findByText(/annual|599/);
    await expectAccessible('detail');
  });

  it('create form (clean and with a validation summary)', async () => {
    signedInServer();
    const { user } = renderApp('/subscriptions/new');
    await screen.findByRole('heading', { name: 'Add a subscription' });
    await expectAccessible('create form');
    await user.click(screen.getByRole('button', { name: 'Add subscription' }));
    await screen.findByRole('alert');
    await expectAccessible('create form with errors');
  });

  it('edit form including the price-change section', async () => {
    detailServer({ sub: richSubs[0]! });
    const { user } = renderApp('/subscriptions/a/edit');
    const price = await screen.findByLabelText(/Price per billing period/);
    await user.clear(price);
    await user.type(price, '799');
    await screen.findByRole('heading', { name: 'Price change' });
    await expectAccessible('edit form');
  });

  it.each([
    ['record payment', 'Record payment', /Record a payment for Netflix/],
    ['record cancellation', 'Record cancellation', /Record that you cancelled Netflix/],
    ['archive', 'Archive', /Archive Netflix/],
    ['pause', 'Pause', /Pause Netflix/],
  ])('the %s dialog', async (_name, opener, title) => {
    detailServer({ sub: richSubs[0]! });
    const { user } = renderApp('/subscriptions/a');
    await user.click(await screen.findByRole('button', { name: opener }));
    await screen.findByRole('dialog', { name: title });
    await expectAccessible(`${opener} dialog`);
  });

  it('the delete confirmations', async () => {
    detailServer({ sub: richSubs[0]!, payments: [makePayment({ subscriptionId: 'a' })] });
    const { user } = renderApp('/subscriptions/a');
    await user.click(await screen.findByRole('button', { name: /Delete payment of/ }));
    await screen.findByRole('dialog', { name: 'Delete this payment record?' });
    await expectAccessible('delete payment dialog');
  });
});

describe('page structure and keyboard navigation', () => {
  it('every page has exactly one level-1 heading, and the document title names the page', async () => {
    signedInServer().on('GET', '/api/subscriptions', page(richSubs, richSubs.length, 1, 100)).on('GET', '/api/subscriptions/:id/payments', page([]));
    const { user } = renderApp('/');
    await screen.findByRole('heading', { name: /Good afternoon/ });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.title).toBe('Home · SubCycle');
    await user.click(screen.getAllByRole('link', { name: /Subscriptions/ })[0]!);
    await screen.findByRole('heading', { name: 'Subscriptions', level: 1 });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(document.title).toBe('Subscriptions · SubCycle');
  });

  it('a skip link is the first tab stop and moves focus to the main content', async () => {
    signedInServer();
    const { user } = renderApp('/subscriptions');
    await screen.findByRole('heading', { name: 'Subscriptions', level: 1 });
    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute('href', '#main');
    expect(document.getElementById('main')).toHaveAttribute('tabindex', '-1');
  });

  it('navigation marks the current page, and moving to another page moves focus to the content', async () => {
    signedInServer().on('GET', '/api/subscriptions/:id/payments', page([]));
    const { user } = renderApp('/');
    await screen.findByRole('heading', { name: /Good afternoon/ });
    const homeLinks = screen.getAllByRole('link', { name: /^Home$/ });
    for (const l of homeLinks) expect(l).toHaveAttribute('aria-current', 'page');
    for (const l of screen.getAllByRole('link', { name: /^Subscriptions$/ })) expect(l).not.toHaveAttribute('aria-current');
    await user.click(screen.getAllByRole('link', { name: /^Subscriptions$/ })[0]!);
    await screen.findByRole('heading', { name: 'Subscriptions', level: 1 });
    for (const l of screen.getAllByRole('link', { name: /^Subscriptions$/ })) expect(l).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(document.getElementById('main')).toHaveFocus());
  });

  it('has two distinctly labelled navigation landmarks (desktop and mobile)', async () => {
    signedInServer();
    renderApp('/subscriptions');
    await screen.findByRole('heading', { name: 'Subscriptions', level: 1 });
    expect(screen.getAllByRole('navigation').map((n) => n.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Primary', 'Primary, mobile']));
  });

  it('the account menu is a disclosure: Escape closes it and returns focus; it offers sign out', async () => {
    const server = signedInServer().on('POST', '/api/auth/logout', { status: 204 });
    const { user } = renderApp('/');
    await screen.findByRole('heading', { name: /Good afternoon/ });
    const button = screen.getByRole('button', { name: /Account menu for Asha Rao/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = document.getElementById('account-menu')!;
    expect(within(menu).getByText('asha@example.com')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
    await user.click(button);
    await user.click(within(document.getElementById('account-menu')!).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(server.to('POST', '/api/auth/logout')).toHaveLength(1);
  });

  it('status is never conveyed by colour alone: badges carry text', async () => {
    signedInServer().on('GET', '/api/subscriptions', page(richSubs, richSubs.length, 1, 25));
    renderApp('/subscriptions');
    await screen.findByText('Netflix');
    expect(within(screen.getByText('Free trial').closest('li')!).getByText('Trial')).toBeInTheDocument();
    expect(within(screen.getByText('Gym').closest('li')!).getByText('Paused')).toBeInTheDocument();
  });

  it('the Estimate / Projection / Recorded labels carry their meaning in text for screen readers', async () => {
    signedInServer().on('GET', '/api/subscriptions', page([makeSub()], 1, 1, 100)).on('GET', '/api/subscriptions/:id/payments', page([]));
    renderApp('/');
    await screen.findByText('Monthly equivalent');
    expect(screen.getAllByText(/Calculated from current prices; may differ from what you were actually charged\./).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Looking forward from today/).length).toBeGreaterThan(0);
  });

  it('respects reduced-motion and keeps focus rings (tokens), as asserted from the stylesheet source', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/index.css', 'utf8'); // vitest runs with apps/web as the working directory
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline: 2px solid var\(--focus\)/);
    // the exact palette from the approved visual direction (neutral dark with a coral accent)
    for (const hex of ['#0c0c0f', '#16161b', '#ff6a5c', '#f6f6f8', '#d4402c']) expect(css.toLowerCase()).toContain(hex);
  });
});


describe('stage 7 pages (axe-core)', () => {
  it('calendar: month grid with renewals and a trial', async () => {
    signedInServer().on('GET', '/api/calendar/renewals', ok(
      [
        { date: '2030-01-20', kind: 'renewal', subscriptionId: 'a', name: 'Netflix', category: 'video', icon: null, amountMinor: 64900, currency: 'INR', billingFrequency: 'monthly', status: 'active' },
        { date: '2030-01-22', kind: 'trial_end', subscriptionId: 'd', name: 'Free trial', category: 'video', icon: null, amountMinor: 29900, currency: 'INR', billingFrequency: 'monthly', status: 'trial' },
      ],
      { from: '2030-01-15', to: '2030-01-31', today: '2030-01-15', timeZone: 'Asia/Kolkata', kind: 'projection', total: 2, truncated: false, totals: [{ currency: 'INR', renewalCount: 1, amountMinor: 64900 }], trialEndCount: 1 },
    ));
    renderApp('/calendar');
    await screen.findByRole('grid');
    await screen.findByText(/free trial ends/);
    await expectAccessible('calendar month');
  });

  it('calendar: list view and empty state', async () => {
    signedInServer().on('GET', '/api/calendar/renewals', ok([], { from: TODAY_, to: '2030-01-22', today: TODAY_, timeZone: 'Asia/Kolkata', kind: 'projection', total: 0, truncated: false, totals: [], trialEndCount: 0 }));
    const { user } = renderApp('/calendar');
    await user.click(await screen.findByRole('button', { name: '7 days' }));
    await screen.findByText('Nothing in the next 7 days');
    await expectAccessible('calendar list empty');
  });

  it('analytics with several currencies', async () => {
    const data = makeAnalytics([makePayment({ paidOn: '2030-01-10' }), makePayment({ paidOn: '2030-01-05', currency: 'USD', amountMinor: 1000 })]);
    data.estimate.currencies = [{ currency: 'INR', subscriptionCount: 1, monthlyEquivalentMinor: 64900, annualizedMinor: 778800, byCategory: [estCategory('video', 64900, 100)], top: [estTop('a', 'Netflix', 64900)] }];
    data.projection.windows = [{ days: 7, to: '2030-01-22', currencies: [{ currency: 'INR', renewalCount: 1, amountMinor: 64900 }], trialEndCount: 0 }];
    signedInServer().on('GET', '/api/analytics/spending', ok(data));
    renderApp('/analytics');
    await screen.findByRole('heading', { name: 'Recorded spending' });
    await expectAccessible('analytics');
  });

  it('analytics empty', async () => {
    signedInServer();
    renderApp('/analytics');
    await screen.findByText('Nothing to analyse yet');
    await expectAccessible('analytics empty');
  });

  it('reminders: inbox, log with skipped reasons, settings (email unconfigured)', async () => {
    signedInServer().on('GET', '/api/reminders', ok(
      [makeReminder(), makeReminder({ channel: 'email', status: 'skipped', skipReason: 'smtp_not_configured', sentAt: null })],
      { page: 1, pageSize: 25, total: 2, unread: 1 },
    ));
    renderApp('/reminders');
    await screen.findAllByText(/Not sent:/);
    await expectAccessible('reminders');
  });

  it('reminders: email configured but unverified', async () => {
    signedInServer().on('GET', '/api/auth/me', ok(emailSession(false)));
    renderApp('/reminders');
    await screen.findByRole('button', { name: 'Send verification email' });
    await expectAccessible('reminders unverified');
  });

  it('verify-email landing states', async () => {
    new FakeServer().on('GET', '/api/auth/me', fail(401, 'UNAUTHENTICATED', 'x')).on('POST', '/api/account/email-verification/confirm', fail(400, 'INVALID_TOKEN', 'bad')).install();
    renderApp('/verify-email?token=zzz');
    await screen.findByText(/invalid or has expired/);
    await expectAccessible('verify email invalid');
  });
});

const TODAY_ = '2030-01-15';
