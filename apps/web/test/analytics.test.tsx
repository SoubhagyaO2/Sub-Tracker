import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsResponse } from '@subcycle/shared';
import { deferred, estCategory, estTop, fail, freezeTime, makeAnalytics, makePayment, ok, renderApp, signedInServer } from './helpers';

beforeEach(() => freezeTime());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const section = (name: string | RegExp) => within(screen.getByRole('heading', { name }).closest('section')!);

function full(): AnalyticsResponse {
  const base = makeAnalytics([
    makePayment({ paidOn: '2030-01-10', amountMinor: 64900 }),
    makePayment({ paidOn: '2030-01-12', amountMinor: 10000, status: 'refunded' }),
    makePayment({ paidOn: '2030-01-13', amountMinor: 99999, status: 'failed' }),
    makePayment({ paidOn: '2029-12-10', amountMinor: 20000 }),
    makePayment({ paidOn: '2030-01-05', amountMinor: 1000, currency: 'USD' }),
  ]);
  return {
    ...base,
    estimate: {
      kind: 'estimate', asOf: '2030-01-15',
      currencies: [
        { currency: 'INR', subscriptionCount: 2, monthlyEquivalentMinor: 76800, annualizedMinor: 921600, byCategory: [estCategory('video', 64900, 84.5), estCategory('music', 11900, 15.5)], top: [estTop('a', 'Netflix', 64900), estTop('b', 'Spotify', 11900)] },
        { currency: 'USD', subscriptionCount: 1, monthlyEquivalentMinor: 1000, annualizedMinor: 12000, byCategory: [estCategory('cloud_storage', 1000, 100)], top: [estTop('c', 'iCloud', 1000)] },
      ],
    },
    projection: {
      kind: 'projection',
      windows: [
        { days: 7, to: '2030-01-22', currencies: [{ currency: 'INR', renewalCount: 1, amountMinor: 64900 }], trialEndCount: 1 },
        { days: 30, to: '2030-02-14', currencies: [{ currency: 'INR', renewalCount: 2, amountMinor: 76800 }, { currency: 'USD', renewalCount: 1, amountMinor: 1000 }], trialEndCount: 1 },
        { days: 90, to: '2030-04-15', currencies: [{ currency: 'INR', renewalCount: 6, amountMinor: 230400 }], trialEndCount: 1 },
      ],
    },
  };
}

describe('analytics page', () => {
  it('asks the server for the last 12 whole months to today, grouped by month', async () => {
    const server = signedInServer().on('GET', '/api/analytics/spending', ok(full()));
    renderApp('/analytics');
    await screen.findByRole('heading', { name: 'Recorded spending' });
    const call = server.to('GET', '/api/analytics/spending')[0]!;
    expect(call.query.get('from')).toBe('2029-02-01');
    expect(call.query.get('to')).toBe('2030-01-15');
    expect(call.query.get('bucket')).toBe('month');
  });

  it('keeps recorded, estimate and projection in separate, labelled cards', async () => {
    signedInServer().on('GET', '/api/analytics/spending', ok(full()));
    renderApp('/analytics');
    await screen.findByRole('heading', { name: 'Recorded spending' });
    expect(section('Recorded spending').getByText('Recorded')).toBeInTheDocument();
    expect(section('Recurring cost').getByText('Estimate')).toBeInTheDocument();
    expect(section('Coming up').getByText('Projection')).toBeInTheDocument();
    expect(screen.getByText(/It is not what you paid/)).toBeInTheDocument();
    expect(screen.getByText(/Not confirmed charges/)).toBeInTheDocument();
    expect(screen.getByText(/doesn’t check them against your bank or the providers/)).toBeInTheDocument();
  });

  it('recorded numbers come from payments only: net = paid − refunded, failed shown but not counted', async () => {
    signedInServer().on('GET', '/api/analytics/spending', ok(full()));
    renderApp('/analytics');
    await screen.findByRole('heading', { name: 'Recorded spending' });
    const rec = section('Recorded spending');
    expect(rec.getByText('Net spent').nextElementSibling).toHaveTextContent(/749\.00.*INR/); // 649 + 200 − 100
    expect(rec.getByText('Refunded').nextElementSibling).toHaveTextContent(/100\.00/);
    expect(rec.getByText(/\+1 failed, not counted/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/999\.99/);
  });

  it('never adds currencies: switching shows the other currency alone, with the hint', async () => {
    signedInServer().on('GET', '/api/analytics/spending', ok(full()));
    const { user } = renderApp('/analytics');
    await screen.findByRole('heading', { name: 'Recorded spending' });
    expect(screen.getByText('Amounts in different currencies are never added together.')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/759\.00|770\.00|778\.00/);
    await user.selectOptions(screen.getByLabelText('Currency'), 'USD');
    expect(section('Recorded spending').getByText('Net spent').nextElementSibling).toHaveTextContent(/10\.00.*USD/);
    expect(section('Recurring cost').getByText('Monthly equivalent').nextElementSibling).toHaveTextContent(/10\.00.*USD/);
    expect(section('Coming up').getByRole('columnheader', { name: /USD/ })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/768\.00/);
  });

  it('the projection table has one row per window and counts every renewal', async () => {
    signedInServer().on('GET', '/api/analytics/spending', ok(full()));
    renderApp('/analytics');
    await screen.findByRole('heading', { name: 'Coming up' });
    const rows = within(screen.getByRole('table', { name: /Expected renewals in INR/ })).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent(/30 days/);
    expect(rows[1]).toHaveTextContent(/2/);
    expect(rows[1]).toHaveTextContent(/768\.00/);
  });

  it('changing the grouping and period re-requests with those parameters', async () => {
    const server = signedInServer().on('GET', '/api/analytics/spending', ok(full()));
    const { user } = renderApp('/analytics');
    await screen.findByRole('heading', { name: 'Recorded spending' });
    await user.selectOptions(screen.getByLabelText('Group recorded payments by'), 'week');
    await screen.findByRole('heading', { name: 'Recorded spending' });
    let call = server.last('GET', '/api/analytics/spending')!;
    expect(call.query.get('bucket')).toBe('week');
    expect(call.query.get('from')).toBe('2029-10-17'); // 13 weeks ending today, inclusive: today − 90 days
    expect(call.query.get('to')).toBe('2030-01-15');
    await user.selectOptions(screen.getByLabelText('Period'), '52');
    await screen.findByRole('heading', { name: 'Recorded spending' });
    call = server.last('GET', '/api/analytics/spending')!;
    expect(call.query.get('from')).toBe('2029-01-17');
  });

  it('with subscriptions but no recorded payments, says nothing is estimated or filled in', async () => {
    const data = full();
    data.recorded.currencies = [];
    signedInServer().on('GET', '/api/analytics/spending', ok(data));
    renderApp('/analytics');
    expect(await screen.findByText('No INR payments recorded in this period')).toBeInTheDocument();
    expect(screen.getByText(/nothing is estimated or filled in from your schedules/)).toBeInTheDocument();
    expect(section('Recurring cost').getByText('Monthly equivalent')).toBeInTheDocument();
  });

  it('an account with nothing at all gets a plain empty state', async () => {
    signedInServer();
    renderApp('/analytics');
    expect(await screen.findByText('Nothing to analyse yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add a subscription' })).toHaveAttribute('href', '/subscriptions/new');
  });

  it('shows a loading region, then an error with Retry that recovers', async () => {
    const gate = deferred();
    const server = signedInServer().on('GET', '/api/analytics/spending', () => gate.promise);
    const { user } = renderApp('/analytics');
    expect(await screen.findByRole('status', { name: 'Loading analytics' })).toBeInTheDocument();
    gate.resolve(fail(500, 'INTERNAL_ERROR', 'Something went wrong.'));
    expect(await screen.findByText('We couldn’t load your analytics')).toBeInTheDocument();
    server.on('GET', '/api/analytics/spending', ok(full()));
    await user.click(screen.getByRole('button', { name: /Try again|Retry/ }));
    expect(await screen.findByRole('heading', { name: 'Recorded spending' })).toBeInTheDocument();
  });
});
