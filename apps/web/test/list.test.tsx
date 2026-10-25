import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, fail, freezeTime, makeSub, page, renderApp, signedInServer, type FakeServer } from './helpers';

beforeEach(() => freezeTime());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const lastQuery = (server: FakeServer) => Object.fromEntries(server.last('GET', '/api/subscriptions')!.query.entries());
const rowFor = (name: string) => screen.getByText(name).closest('li')!;

describe('subscription list', () => {
  it('shows each subscription with price, currency, cadence, status and the effective next date', async () => {
    signedInServer().on('GET', '/api/subscriptions', page([
      makeSub({ id: 'a', name: 'Netflix', amountMinor: 64900, effectiveNextBillingDate: '2030-02-01' }),
      makeSub({ id: 'b', name: 'Dropbox', category: 'cloud_storage', amountMinor: 1200000, billingFrequency: 'yearly', currency: 'USD' }),
      makeSub({ id: 'c', name: 'Gym', category: 'fitness_health', status: 'paused', effectiveNextBillingDate: null, nextBillingDate: '2030-01-03' }),
      makeSub({ id: 'd', name: 'Old news', category: 'news_reading', status: 'cancelled', cancelledOn: '2030-01-04', effectiveNextBillingDate: null }),
      makeSub({ id: 'e', name: 'Stale', nextBillingDate: '2030-01-05', anchorDate: '2030-01-05', effectiveNextBillingDate: '2030-02-05' }),
    ]));
    renderApp('/subscriptions');
    await screen.findByText('Netflix');

    const netflix = within(rowFor('Netflix'));
    expect(netflix.getByText(/649\.00/)).toHaveTextContent(/INR/);
    expect(netflix.getByText(/\/ month/)).toBeInTheDocument();
    expect(netflix.getByText(/Next:/)).toBeInTheDocument();
    expect(netflix.queryByText(/estimate/i)).not.toBeInTheDocument(); // monthly: nothing to convert

    const dropbox = within(rowFor('Dropbox')); // yearly in USD: shows the monthly equivalent, clearly an estimate, same currency
    expect(dropbox.getByText(/12,000\.00/)).toHaveTextContent(/USD/);
    expect(dropbox.getByText(/≈/).parentElement).toHaveTextContent(/1,000\.00.*USD.*month.*estimate/);

    expect(within(rowFor('Gym')).getByText('Paused')).toBeInTheDocument();
    expect(within(rowFor('Gym')).queryByText(/Next:/)).not.toBeInTheDocument();
    expect(within(rowFor('Old news')).getByText('Cancelled')).toBeInTheDocument();
    expect(within(rowFor('Old news')).getByText(/Cancelled.*4/)).toBeInTheDocument();

    const stale = rowFor('Stale');
    expect(stale).toHaveTextContent('in 21 days'); // Feb 5, from the effective date, not "10 days ago"
    expect(stale).not.toHaveTextContent('days ago');
  });

  it('links each row to its detail page', async () => {
    signedInServer().on('GET', '/api/subscriptions', page([makeSub({ id: 'abc', name: 'Netflix' })]));
    renderApp('/subscriptions');
    expect((await screen.findByText('Netflix')).closest('a')).toHaveAttribute('href', '/subscriptions/abc');
  });

  it('hides archived by default (all other statuses requested) and uses the documented query shape', async () => {
    const server = signedInServer();
    renderApp('/subscriptions');
    await screen.findByText('No subscriptions yet');
    expect(lastQuery(server)).toEqual({ page: '1', pageSize: '25', status: 'active,trial,paused,cancelled', sort: 'created', order: 'desc' });
  });

  describe('loading, empty and error states', () => {
    it('loading skeleton is announced, then replaced by results', async () => {
      const gate = deferred();
      signedInServer().on('GET', '/api/subscriptions', () => gate.promise);
      renderApp('/subscriptions');
      expect(await screen.findByRole('status', { name: 'Loading subscriptions' })).toBeInTheDocument();
      gate.resolve(page([makeSub({ name: 'Netflix' })]));
      expect(await screen.findByText('Netflix')).toBeInTheDocument();
      expect(screen.queryByRole('status', { name: 'Loading subscriptions' })).not.toBeInTheDocument();
    });

    it('no subscriptions at all: invites adding one; with filters: says nothing matches and offers to clear them', async () => {
      signedInServer();
      const { user } = renderApp('/subscriptions?category=music');
      expect(await screen.findByText('No subscriptions match these filters')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(await screen.findByText('No subscriptions yet')).toBeInTheDocument();
      expect(screen.getAllByRole('link', { name: /Add subscription/ }).length).toBeGreaterThan(0);
    });

    it('API failure: safe message, reference, and Retry', async () => {
      let n = 0;
      signedInServer().on('GET', '/api/subscriptions', () => (++n === 1 ? fail(503, 'UNAVAILABLE', 'The service is busy. Please try again.') : page([makeSub({ name: 'Netflix' })])));
      const { user } = renderApp('/subscriptions');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('We couldn’t load your subscriptions');
      expect(alert).toHaveTextContent('The service is busy.');
      await user.click(within(alert).getByRole('button', { name: /try again/i }));
      expect(await screen.findByText('Netflix')).toBeInTheDocument();
    });
  });

  describe('search, filter and sort', () => {
    it('search is debounced into the URL and the request (one request for fast typing)', async () => {
      const server = signedInServer();
      const { user } = renderApp('/subscriptions');
      await screen.findByText('No subscriptions yet');
      const before = server.to('GET', '/api/subscriptions').length;
      await user.type(screen.getByLabelText('Search by name'), 'net');
      await waitFor(() => expect(lastQuery(server).q).toBe('net'), { timeout: 3000 });
      expect(server.to('GET', '/api/subscriptions').length).toBe(before + 1);
    });

    it.each([
      ['Status', 'paused', 'status', 'paused'],
      ['Status', 'archived', 'status', 'archived'],
      ['Category', 'music', 'category', 'music'],
      ['Billing frequency', 'yearly', 'frequency', 'yearly'],
      ['Currency', 'USD', 'currency', 'USD'],
      ['Upcoming renewal', '30', 'renewsWithinDays', '30'],
    ])('choosing %s = %s sends %s=%s and resets to page 1', async (label, value, param, expected) => {
      const server = signedInServer();
      const { user } = renderApp('/subscriptions?page=3');
      await screen.findByLabelText(label as string);
      await user.selectOptions(screen.getByLabelText(label as string), value as string);
      await waitFor(() => expect(lastQuery(server)[param as string]).toBe(expected));
      expect(lastQuery(server).page).toBe('1');
    });

    it('sorting: field and order are sent; each field has a sensible default order', async () => {
      const server = signedInServer();
      const { user } = renderApp('/subscriptions');
      await screen.findByLabelText('Sort by');
      await user.selectOptions(screen.getByLabelText('Sort by'), 'nextRenewal');
      await waitFor(() => expect(lastQuery(server)).toMatchObject({ sort: 'nextRenewal', order: 'asc' }));
      await user.selectOptions(screen.getByLabelText('Order'), 'desc');
      await waitFor(() => expect(lastQuery(server)).toMatchObject({ sort: 'nextRenewal', order: 'desc' }));
      await user.selectOptions(screen.getByLabelText('Sort by'), 'name');
      await waitFor(() => expect(lastQuery(server)).toMatchObject({ sort: 'name', order: 'asc' }));
      await user.selectOptions(screen.getByLabelText('Sort by'), 'price');
      await waitFor(() => expect(lastQuery(server)).toMatchObject({ sort: 'price', order: 'desc' }));
      expect(screen.getByText(/aren’t converted/)).toBeInTheDocument(); // price sort without a currency is explained
    });

    it('price range needs a currency; amounts are sent as minor units of the monthly equivalent', async () => {
      const server = signedInServer();
      const { user } = renderApp('/subscriptions');
      await screen.findByLabelText('Currency');
      expect(screen.getByLabelText('Min monthly price')).toBeDisabled();
      expect(screen.getByLabelText('Max monthly price')).toBeDisabled();
      await user.selectOptions(screen.getByLabelText('Currency'), 'INR');
      await user.type(screen.getByLabelText('Min monthly price'), '5');
      await user.type(screen.getByLabelText('Max monthly price'), '1,000.50');
      await waitFor(() => expect(lastQuery(server)).toMatchObject({ currency: 'INR', minPrice: '500', maxPrice: '100050' }), { timeout: 3000 });
    });

    it('an unusable price range is flagged next to the field and is not sent', async () => {
      const server = signedInServer();
      const { user } = renderApp('/subscriptions?currency=INR&min=100&max=50');
      expect(await screen.findByText('Minimum must not exceed maximum.')).toBeInTheDocument();
      expect(lastQuery(server).minPrice).toBeUndefined();
      await user.clear(screen.getByLabelText('Min monthly price'));
      await user.type(screen.getByLabelText('Min monthly price'), '12.345');
      expect(await screen.findByText(/at most 2 decimal places/)).toBeInTheDocument();
    });

    it('filters come from, and are restored from, the URL (shareable, back-button friendly)', async () => {
      const server = signedInServer();
      renderApp('/subscriptions?status=trial&category=video&sort=name&order=desc&q=ne&renews=7');
      await screen.findByLabelText('Status');
      expect(screen.getByLabelText('Status')).toHaveValue('trial');
      expect(screen.getByLabelText('Category')).toHaveValue('video');
      expect(screen.getByLabelText('Search by name')).toHaveValue('ne');
      expect(screen.getByLabelText('Sort by')).toHaveValue('name');
      expect(screen.getByLabelText('Order')).toHaveValue('desc');
      expect(lastQuery(server)).toMatchObject({ status: 'trial', category: 'video', q: 'ne', renewsWithinDays: '7', sort: 'name', order: 'desc' });
    });

    it('"Clear filters" resets everything except the sort', async () => {
      const server = signedInServer();
      const { user } = renderApp('/subscriptions?status=paused&category=music&sort=name');
      await user.click(await screen.findByRole('button', { name: 'Clear filters' }));
      await waitFor(() => expect(lastQuery(server)).toEqual({ page: '1', pageSize: '25', status: 'active,trial,paused,cancelled', sort: 'name', order: 'asc' }));
    });

    it('the mobile filter toggle reports its state', async () => {
      signedInServer();
      const { user } = renderApp('/subscriptions');
      const toggle = await screen.findByRole('button', { name: /^Filters/ });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(toggle).toHaveAttribute('aria-controls', 'filter-panel');
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('pagination', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => makeSub({ id: `s${i}`, name: `Sub ${i}` }));
    it('shows the page position and moves between pages with the server\'s own paging', async () => {
      const server = signedInServer().on('GET', '/api/subscriptions', (req) => {
        const p = Number(req.query.get('page'));
        return page(many(25), 60, p, 25);
      });
      const { user } = renderApp('/subscriptions');
      const nav = await screen.findByRole('navigation', { name: 'Subscriptions pagination' });
      expect(within(nav).getByText(/Page 1 of 3/)).toBeInTheDocument();
      expect(within(nav).getByRole('button', { name: /Previous/ })).toBeDisabled();
      await user.click(within(nav).getByRole('button', { name: /Next/ }));
      await waitFor(() => expect(lastQuery(server).page).toBe('2'));
      expect(await screen.findByText(/Page 2 of 3/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Next/ }));
      await screen.findByText(/Page 3 of 3/);
      expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled();
    });
    it('no pagination controls when everything fits on one page', async () => {
      signedInServer().on('GET', '/api/subscriptions', page(many(3), 3));
      renderApp('/subscriptions');
      await screen.findByText('Sub 0');
      expect(screen.queryByRole('navigation', { name: 'Subscriptions pagination' })).not.toBeInTheDocument();
      expect(screen.getByText('3 subscriptions')).toBeInTheDocument();
    });
  });
});
