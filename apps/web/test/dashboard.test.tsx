import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, fail, freezeTime, makePayment, makeSub, page, renderApp, signedInServer } from './helpers';

beforeEach(() => freezeTime());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const card = (name: RegExp | string) => {
  const heading = screen.getByRole('heading', { name });
  return within(heading.closest('section')!);
};

/** Server with the given subscriptions and a payments endpoint keyed by subscription id. */
function serverWith(subs: ReturnType<typeof makeSub>[], payments: Record<string, ReturnType<typeof makePayment>[]> = {}) {
  return signedInServer()
    .on('GET', '/api/subscriptions', page(subs, subs.length, 1, 100))
    .on('GET', '/api/subscriptions/:id/payments', (_req, p) => page(payments[p.id!] ?? [], (payments[p.id!] ?? []).length, 1, 100));
}

describe('dashboard states', () => {
  it('shows a labelled loading state, then content', async () => {
    const gate = deferred();
    signedInServer().on('GET', '/api/subscriptions', () => gate.promise);
    renderApp('/');
    expect(await screen.findByRole('status', { name: 'Loading your dashboard' })).toBeInTheDocument();
    gate.resolve(page([makeSub()], 1, 1, 100));
    expect(await screen.findByRole('heading', { name: /Good afternoon, Asha/ })).toBeInTheDocument();
  });

  it('an empty account gets a clear call to action and nothing fabricated', async () => {
    serverWith([]);
    renderApp('/');
    expect(await screen.findByText('Nothing tracked yet')).toBeInTheDocument();
    const cta = screen.getAllByRole('link', { name: /Add subscription/ }).find((l) => l.getAttribute('href') === '/subscriptions/new');
    expect(cta).toBeTruthy();
    expect(screen.queryByText(/Estimate/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Recorded/)).not.toBeInTheDocument();
  });

  it('an API failure shows a safe message with Retry, and Retry reloads', async () => {
    let calls = 0;
    signedInServer()
      .on('GET', '/api/subscriptions', () => (++calls === 1 ? fail(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.') : page([makeSub()], 1, 1, 100)))
      .on('GET', '/api/subscriptions/:id/payments', page([]));
    const { user } = renderApp('/');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We couldn’t load your subscriptions');
    expect(alert).toHaveTextContent('Something went wrong. Please try again.');
    expect(alert).toHaveTextContent('Reference: req-test-1');
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Monthly equivalent')).toBeInTheDocument();
  });

  it('a payments failure is contained to the payments cards: the rest of the dashboard still works', async () => {
    serverWith([makeSub()]).on('GET', '/api/subscriptions/:id/payments', fail(500, 'INTERNAL_ERROR', 'Payments are unavailable.'));
    renderApp('/');
    await screen.findByText('Monthly equivalent');
    expect(await screen.findByText('We couldn’t load your payments')).toBeInTheDocument();
    expect(card(/Spending by category/)).toBeTruthy();
  });
});

describe('estimates, projections and recorded payments are kept apart and labelled', () => {
  const subs = [makeSub({ id: 'a', name: 'Netflix', amountMinor: 64900 }), makeSub({ id: 'b', name: 'Spotify', category: 'music', amountMinor: 11900 })];

  it('labels each figure as Estimate, Projection or Recorded', async () => {
    serverWith(subs, { a: [makePayment({ subscriptionId: 'a' })] });
    renderApp('/');
    await screen.findByText('Monthly equivalent');
    expect(card('Monthly equivalent')).toBeTruthy();
    expect(within(screen.getByRole('heading', { name: 'Monthly equivalent' }).closest('section')!).getByText('Estimate')).toBeInTheDocument();
    expect(within(screen.getByRole('heading', { name: 'Annualized cost' }).closest('section')!).getByText('Projection')).toBeInTheDocument();
    expect(within(screen.getByRole('heading', { name: 'Renewing in 7 days' }).closest('section')!).getByText('Projection')).toBeInTheDocument();
    await screen.findByText('Recorded payments by month');
    expect(within(screen.getByRole('heading', { name: 'Recorded payments by month' }).closest('section')!).getByText('Recorded')).toBeInTheDocument();
    expect(within(screen.getByRole('heading', { name: 'Spending by category' }).closest('section')!).getByText('Estimate')).toBeInTheDocument();
    expect(within(screen.getByRole('heading', { name: 'Recent payments' }).closest('section')!).getByText('Recorded')).toBeInTheDocument();
  });

  it('the monthly equivalent is computed from subscriptions, and is not money "paid"', async () => {
    serverWith(subs);
    renderApp('/');
    await screen.findByText('Monthly equivalent');
    const kpi = card('Monthly equivalent');
    expect(kpi.getByText(/768\.00/)).toBeInTheDocument(); // 649 + 119
    expect(card('Annualized cost').getByText(/9,216\.00|9216\.00/)).toBeInTheDocument(); // 768 x 12
    expect(screen.getByText(/Not what you paid/)).toBeInTheDocument();
  });

  it('with active subscriptions but NO payments, the recorded chart is empty and says nothing is estimated', async () => {
    serverWith(subs);
    renderApp('/');
    expect(await screen.findByText('No payments recorded yet')).toBeInTheDocument();
    expect(screen.getByText(/nothing is estimated or filled in/i)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Recorded payments/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing recorded yet\. Only payments you record appear here\./)).toBeInTheDocument();
  });

  it('recorded totals come only from payment records: paid minus refunded, failed ignored', async () => {
    serverWith(subs, {
      a: [
        makePayment({ subscriptionId: 'a', paidOn: '2030-01-10', amountMinor: 64900 }),
        makePayment({ subscriptionId: 'a', paidOn: '2030-01-12', amountMinor: 10000, status: 'refunded' }),
        makePayment({ subscriptionId: 'a', paidOn: '2030-01-13', amountMinor: 99999, status: 'failed' }),
        makePayment({ subscriptionId: 'a', paidOn: '2029-12-10', amountMinor: 20000 }),
      ],
    });
    const { user } = renderApp('/');
    await screen.findByRole('img', { name: /Recorded payments/ });
    const chart = screen.getByRole('img', { name: /Recorded payments/ });
    expect(chart).toHaveAccessibleName(/549\.00.*INR|549\.00/); // 649 - 100 refunded; the failed 999.99 is excluded
    await user.click(within(screen.getByRole('heading', { name: 'Recorded payments by month' }).closest('section')!).getByRole('button', { name: 'View as table' }));
    const table = screen.getByRole('table');
    expect(within(table).getByRole('row', { name: /Jan.*549\.00/ })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /Dec.*200\.00/ })).toBeInTheDocument();
    expect(within(table).queryByText(/999\.99/)).not.toBeInTheDocument(); // the failed payment is not in the chart's numbers
    // ...but it IS listed honestly, labelled Failed, in the recent payments list
    const recent = within(screen.getByRole('heading', { name: 'Recent payments' }).closest('section')!);
    expect(recent.getByText(/999\.99/).closest('li')).toHaveTextContent('Failed');
    // the estimate is untouched by recorded payments
    expect(card('Monthly equivalent').getByText(/768\.00/)).toBeInTheDocument();
  });

  it('payments of ARCHIVED subscriptions still count as history: all statuses are requested', async () => {
    const archived = makeSub({ id: 'z', name: 'Old', status: 'archived', effectiveNextBillingDate: null });
    const server = serverWith([...subs, archived], { z: [makePayment({ subscriptionId: 'z', paidOn: '2030-01-05', amountMinor: 30000 })] });
    renderApp('/');
    await screen.findByRole('img', { name: /Recorded payments/ });
    const call = server.to('GET', '/api/subscriptions')[0]!;
    expect(call.query.get('status')).toBe('active,trial,paused,cancelled,archived');
    expect(call.query.get('pageSize')).toBe('100');
    expect(server.to('GET', '/api/subscriptions/z/payments')).toHaveLength(1);
  });

  it('only active subscriptions count in totals; paused, trial and archived are excluded and explained', async () => {
    serverWith([
      makeSub({ id: 'a', amountMinor: 1000 }),
      makeSub({ id: 'b', amountMinor: 5000, status: 'paused', effectiveNextBillingDate: null }),
      makeSub({ id: 'c', amountMinor: 7000, status: 'trial', trialEndDate: '2030-02-01', effectiveNextBillingDate: '2030-02-01' }),
      makeSub({ id: 'd', amountMinor: 9000, status: 'archived', effectiveNextBillingDate: null }),
    ]);
    renderApp('/');
    await screen.findByText('Monthly equivalent');
    expect(card('Monthly equivalent').getByText(/10\.00/)).toBeInTheDocument();
    expect(card('Active subscriptions').getByText('1', { selector: 'p' })).toBeInTheDocument();
    expect(card('Active subscriptions').getByText(/1 on trial · 1 paused \(not counted in totals\)/)).toBeInTheDocument();
  });
});

describe('multiple currencies are never combined', () => {
  const subs = [
    makeSub({ id: 'a', name: 'Netflix', amountMinor: 64900 }),
    makeSub({ id: 'b', name: 'Spotify', category: 'music', amountMinor: 11900 }),
    makeSub({ id: 'c', name: 'iCloud', category: 'cloud_storage', amountMinor: 1000, currency: 'USD' }),
  ];

  it('shows one line per currency, preferred first, each with its code, and never a mixed total', async () => {
    serverWith(subs);
    renderApp('/');
    await screen.findByText('Monthly equivalent');
    const kpi = card('Monthly equivalent');
    const lines = kpi.getAllByText(/\d\.\d\d/).map((n) => n.textContent ?? '');
    expect(lines[0]).toMatch(/768\.00.*INR/);
    expect(lines[1]).toMatch(/10\.00.*USD/);
    // 768 + 10 = 778 would be a meaningless blend of rupees and dollars: it must appear nowhere.
    expect(document.body).not.toHaveTextContent(/778\.00/);
    expect(document.body).not.toHaveTextContent(/9,336|9336/); // 778 x 12
  });

  it('the annualized figure is also per currency', async () => {
    serverWith(subs);
    renderApp('/');
    await screen.findByText('Annualized cost');
    const kpi = card('Annualized cost');
    expect(kpi.getByText(/9,216\.00/)).toHaveTextContent(/INR/);
    expect(kpi.getByText(/120\.00/)).toHaveTextContent(/USD/);
  });

  it('category and recorded charts offer a currency switch instead of mixing', async () => {
    serverWith(subs, { a: [makePayment({ subscriptionId: 'a', amountMinor: 64900 })], c: [makePayment({ subscriptionId: 'c', currency: 'USD', amountMinor: 1000 })] });
    const { user } = renderApp('/');
    await screen.findByRole('img', { name: /Recorded payments/ });
    const rec = within(screen.getByRole('heading', { name: 'Recorded payments by month' }).closest('section')!);
    expect(rec.getByRole('img', { name: /649\.00/ })).toBeInTheDocument(); // INR first (preferred)
    await user.selectOptions(rec.getByLabelText('Currency'), 'USD');
    expect(rec.getByRole('img', { name: /10\.00.*USD|USD.*10\.00/ })).toBeInTheDocument();
    const cat = within(screen.getByRole('heading', { name: 'Spending by category' }).closest('section')!);
    expect(cat.getByText(/Video/)).toBeInTheDocument();
    await user.selectOptions(cat.getByLabelText('Currency'), 'USD');
    expect(cat.getByText(/Cloud storage/)).toBeInTheDocument();
    expect(cat.queryByText(/^Video$/)).not.toBeInTheDocument();
  });

  it('recorded payments in a different currency than the subscription keep their own currency', async () => {
    serverWith([subs[0]!], { a: [makePayment({ subscriptionId: 'a', currency: 'USD', amountMinor: 799 })] });
    renderApp('/');
    const recent = within((await screen.findByRole('heading', { name: 'Recent payments' })).closest('section')!);
    expect(await recent.findByText(/7\.99/)).toHaveTextContent(/USD/);
  });
});

describe('upcoming renewals use the effective date', () => {
  const stale = makeSub({ id: 'st', name: 'Stale one', nextBillingDate: '2030-01-05', anchorDate: '2030-01-05', effectiveNextBillingDate: '2030-02-05' });
  const soon = makeSub({ id: 'so', name: 'Due soon', nextBillingDate: '2030-01-18', effectiveNextBillingDate: '2030-01-18', anchorDate: '2030-01-18' });
  const trial = makeSub({ id: 'tr', name: 'Free trial', status: 'trial', trialEndDate: '2030-01-20', nextBillingDate: '2030-01-20', effectiveNextBillingDate: '2030-01-20', amountMinor: 29900 });
  const paused = makeSub({ id: 'pa', name: 'Paused one', status: 'paused', nextBillingDate: '2030-01-17', effectiveNextBillingDate: null });
  const cancelled = makeSub({ id: 'ca', name: 'Cancelled one', status: 'cancelled', cancelledOn: '2030-01-01', effectiveNextBillingDate: null });
  const all = [stale, soon, trial, paused, cancelled];

  it('lists the calculated date (not the stale saved one), in date order, with trials marked and non-billing statuses absent', async () => {
    serverWith(all);
    renderApp('/');
    const section = within((await screen.findByRole('heading', { name: 'Upcoming renewals' })).closest('section')!);
    const rows = section.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/subscriptions/'));
    expect(rows.map((r) => r.querySelector('span.truncate')?.textContent)).toEqual(['Due soon', 'Free trial', 'Stale one']);
    expect(rows[0]).toHaveTextContent(/18/);
    expect(rows[0]).toHaveTextContent('in 3 days');
    expect(rows[1]).toHaveTextContent('Trial ends');
    expect(rows[2]).toHaveTextContent('in 21 days'); // Feb 5, not the saved Jan 5 (which would read "10 days ago")
    expect(rows[2]).toHaveTextContent('calculated from schedule');
    expect(rows[2]).not.toHaveTextContent('days ago');
    expect(section.queryByText('Paused one')).not.toBeInTheDocument();
    expect(section.queryByText('Cancelled one')).not.toBeInTheDocument();
    expect(section.getByText('Projection')).toBeInTheDocument();
  });

  it('the window control filters the list (7 / 30 / 90 days)', async () => {
    serverWith(all);
    const { user } = renderApp('/');
    const section = within((await screen.findByRole('heading', { name: 'Upcoming renewals' })).closest('section')!);
    expect(section.getByText('Stale one')).toBeInTheDocument();
    await user.click(section.getByRole('button', { name: '7 days' }));
    expect(section.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(section.queryByText('Stale one')).not.toBeInTheDocument();
    expect(section.getByText('Due soon')).toBeInTheDocument();
    await user.click(section.getByRole('button', { name: '90 days' }));
    expect(section.getByText('Stale one')).toBeInTheDocument();
  });

  it('the 7-day KPI counts renewals and trial endings, and totals only real charges', async () => {
    serverWith(all);
    renderApp('/');
    await screen.findByText('Renewing in 7 days');
    const kpi = card('Renewing in 7 days');
    expect(kpi.getByText('2', { selector: 'p' })).toBeInTheDocument(); // Due soon + Free trial
    expect(kpi.getByText(/649\.00/)).toBeInTheDocument(); // only "Due soon" is a charge; the trial's 299 is not
    expect(kpi.queryByText(/299\.00/)).not.toBeInTheDocument();
  });

  it('empty window: explains who does not renew', async () => {
    serverWith([paused, cancelled]);
    renderApp('/');
    expect(await screen.findByText('No renewals in the next 30 days')).toBeInTheDocument();
    expect(screen.getByText(/Paused, cancelled and archived subscriptions don’t renew/)).toBeInTheDocument();
  });
});

describe('recently added', () => {
  it('lists the newest subscriptions with the date they were added in the user’s zone', async () => {
    serverWith([
      makeSub({ id: 'a', name: 'Oldest', createdAt: '2029-06-01T00:00:00Z' }),
      makeSub({ id: 'b', name: 'Newest', createdAt: '2030-01-14T20:30:00Z' }), // 02:00 on Jan 15 in Kolkata
    ]);
    renderApp('/');
    const section = within((await screen.findByRole('heading', { name: 'Recently added' })).closest('section')!);
    const names = section.getAllByRole('link').map((a) => a.textContent);
    expect(names[0]).toMatch(/Newest/);
    expect(names[0]).toMatch(/Added.*15/);
  });
});

describe('request shape', () => {
  it('uses only documented read endpoints, with the CSRF header and same-origin credentials', async () => {
    const server = serverWith([makeSub({ id: 'a' })]);
    renderApp('/');
    await screen.findByText('Monthly equivalent');
    await waitFor(() => expect(server.to('GET', '/api/subscriptions/a/payments').length).toBe(1));
    const documented = [/^\/api\/auth\/me$/, /^\/api\/subscriptions$/, /^\/api\/subscriptions\/[^/]+\/payments$/];
    for (const c of server.calls) {
      expect(c.method).toBe('GET');
      expect(documented.some((re) => re.test(c.path)), c.path).toBe(true);
      expect(c.headers.get('X-SubCycle-Client')).toBe('web');
      expect(c.credentials).toBe('same-origin');
    }
  });
});
