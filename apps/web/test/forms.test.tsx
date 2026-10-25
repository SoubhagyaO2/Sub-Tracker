import { screen, waitFor, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, fail, freezeTime, makeHistory, makePayment, makeSub, ok, page, renderApp, signedInServer, type FakeServer } from './helpers';

beforeEach(() => freezeTime());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;
const created = makeSub({ id: 'new1', name: 'Spotify', category: 'music', amountMinor: 11900 });

/** A server that can also show the detail page after creating/editing. */
function formServer(sub = created): FakeServer {
  return signedInServer()
    .on('GET', '/api/subscriptions/:id', ok(sub))
    .on('GET', '/api/subscriptions/:id/payments', page([makePayment({ subscriptionId: sub.id })]))
    .on('GET', '/api/subscriptions/:id/price-history', page([makeHistory({ subscriptionId: sub.id })]))
    .on('GET', '/api/subscriptions/:id/upcoming', ok([]))
    .on('POST', '/api/subscriptions', { status: 201, body: { data: sub } });
}

async function fillBasics(user: User, { name = 'Spotify', amount = '119', date = '2030-02-10' } = {}) {
  await user.type(await screen.findByLabelText(/Service name/), name);
  await user.type(screen.getByLabelText(/Price per billing period/), amount);
  if (date) await user.type(screen.getByLabelText(/Next billing date/), date);
}

describe('create subscription', () => {
  it('posts minor units and only what was entered, then opens the new subscription', async () => {
    const server = formServer();
    const { user } = renderApp('/subscriptions/new');
    await fillBasics(user);
    await user.selectOptions(screen.getByLabelText('Category'), 'music');
    await user.click(screen.getByRole('button', { name: 'Add subscription' }));

    expect(await screen.findByRole('heading', { name: 'Spotify', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Added Spotify.')).toBeInTheDocument(); // success feedback
    const call = server.last('POST', '/api/subscriptions')!;
    expect(call.body).toEqual({
      name: 'Spotify', amountMinor: 11900, billingFrequency: 'monthly', category: 'music', currency: 'INR', status: 'active', nextBillingDate: '2030-02-10',
    });
    expect(call.headers.get('X-SubCycle-Client')).toBe('web');
  });

  it('uses the preferred currency by default and sends zero-decimal currencies correctly', async () => {
    const server = formServer();
    const { user } = renderApp('/subscriptions/new');
    expect(await screen.findByLabelText('Currency')).toHaveValue('INR');
    await user.selectOptions(screen.getByLabelText('Currency'), 'JPY');
    await fillBasics(user, { name: 'Anime Pass', amount: '980' });
    await user.click(screen.getByRole('button', { name: 'Add subscription' }));
    await waitFor(() => expect(server.last('POST', '/api/subscriptions')?.body).toMatchObject({ currency: 'JPY', amountMinor: 980 }));
  });

  it('accepts a trial: asks for the end date and sends the trial status', async () => {
    const server = formServer();
    const { user } = renderApp('/subscriptions/new');
    await user.type(await screen.findByLabelText(/Service name/), 'Streaming');
    await user.type(screen.getByLabelText(/Price per billing period/), '299');
    await user.click(screen.getByRole('radio', { name: 'Yes, free trial' }));
    await user.type(await screen.findByLabelText(/Trial ends on/), '2030-01-29');
    await user.click(screen.getByRole('button', { name: 'Add subscription' }));
    await waitFor(() => expect(server.last('POST', '/api/subscriptions')?.body).toMatchObject({ status: 'trial', trialEndDate: '2030-01-29', nextBillingDate: '2030-01-29' }));
  });

  it('sends the original billing date for month-end schedules, and warns when a short-month date might need it', async () => {
    const server = formServer();
    const { user } = renderApp('/subscriptions/new');
    await fillBasics(user, { date: '2030-02-28' });
    expect(screen.getByText(/29th, 30th or 31st/)).toBeInTheDocument();
    await user.click(screen.getByText('Advanced schedule options'));
    await user.type(screen.getByLabelText(/Original billing date/), '2030-01-31');
    await user.click(screen.getByRole('button', { name: 'Add subscription' }));
    await waitFor(() => expect(server.last('POST', '/api/subscriptions')?.body).toMatchObject({ anchorDate: '2030-01-31', nextBillingDate: '2030-02-28' }));
  });

  describe('validation (client side)', () => {
    it('blocks an empty submit, lists every problem, links them to fields, and focuses the first invalid field', async () => {
      const server = formServer();
      const { user } = renderApp('/subscriptions/new');
      await user.click(await screen.findByRole('button', { name: 'Add subscription' }));
      const summary = await screen.findByRole('alert');
      expect(within(summary).getByText('Enter a name.')).toBeInTheDocument();
      expect(within(summary).getByText('Enter an amount.')).toBeInTheDocument();
      expect(within(summary).getByText('Enter the next billing date.')).toBeInTheDocument();
      expect(server.to('POST', '/api/subscriptions')).toHaveLength(0);
      await waitFor(() => expect(screen.getByLabelText(/Service name/)).toHaveFocus());

      // each error is tied to its field for assistive tech
      const name = screen.getByLabelText(/Service name/);
      expect(name).toHaveAttribute('aria-invalid', 'true');
      expect(document.getElementById(name.getAttribute('aria-describedby')!)).toHaveTextContent('Enter a name.');

      // the summary links jump to the field
      await user.click(within(summary).getByRole('link', { name: 'Enter an amount.' }));
      expect(screen.getByLabelText(/Price per billing period/)).toHaveFocus();
    });

    it.each([
      ['abc', /digits/],
      ['12.345', /at most 2 decimal places/],
      ['0', /greater than zero/],
      ['-5', /digits/],
    ])('rejects the price %j', async (amount, message) => {
      formServer();
      const { user } = renderApp('/subscriptions/new');
      await fillBasics(user, { amount });
      await user.click(screen.getByRole('button', { name: 'Add subscription' }));
      expect(await within(await screen.findByRole('alert')).findByText(message)).toBeInTheDocument();
    });

    it('rejects a decimal amount in a currency without decimals', async () => {
      formServer();
      const { user } = renderApp('/subscriptions/new');
      await user.selectOptions(await screen.findByLabelText('Currency'), 'JPY');
      await fillBasics(user, { amount: '980.5' });
      await user.click(screen.getByRole('button', { name: 'Add subscription' }));
      expect(await screen.findAllByText(/JPY has no decimal places/)).toHaveLength(2); // in the summary and beside the field
    });

    it('rejects a billing date in the past (today is fine) using the user’s own day', async () => {
      const server = formServer();
      const { user } = renderApp('/subscriptions/new');
      await fillBasics(user, { date: '2030-01-14' });
      await user.click(screen.getByRole('button', { name: 'Add subscription' }));
      expect((await screen.findAllByText('Next billing date can’t be in the past.')).length).toBeGreaterThan(0);
      expect(server.to('POST', '/api/subscriptions')).toHaveLength(0);
      await user.clear(screen.getByLabelText(/Next billing date/));
      await user.type(screen.getByLabelText(/Next billing date/), '2030-01-15');
      await user.click(screen.getByRole('button', { name: 'Add subscription' }));
      await waitFor(() => expect(server.to('POST', '/api/subscriptions')).toHaveLength(1));
    });

    it('a trial must have an end date', async () => {
      formServer();
      const { user } = renderApp('/subscriptions/new');
      await user.type(await screen.findByLabelText(/Service name/), 'X');
      await user.type(screen.getByLabelText(/Price per billing period/), '10');
      await user.click(screen.getByRole('radio', { name: 'Yes, free trial' }));
      await user.click(screen.getByRole('button', { name: 'Add subscription' }));
      expect((await screen.findAllByText('Enter the day your trial ends.')).length).toBeGreaterThan(0);
    });

    it('refuses card numbers in the payment-method label before anything is sent', async () => {
      const server = formServer();
      const { user } = renderApp('/subscriptions/new');
      await fillBasics(user);
      await user.type(screen.getByLabelText(/Payment method label/), '4111 1111 1111 1111');
      await user.click(screen.getByRole('button', { name: 'Add subscription' }));
      expect((await screen.findAllByText(/Don’t enter card numbers/)).length).toBeGreaterThan(0);
      expect(server.to('POST', '/api/subscriptions')).toHaveLength(0);
    });
  });

  describe('server-side errors', () => {
    it('field-level 422 details appear on the right fields and the form stays editable', async () => {
      formServer().on('POST', '/api/subscriptions', fail(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [
        { path: 'name', message: 'Name is already taken in your list.' },
        { path: 'websiteUrl', message: 'Enter a valid http(s) URL without credentials.' },
      ]));
      const { user } = renderApp('/subscriptions/new');
      await fillBasics(user);
      await user.click(screen.getByRole('button', { name: 'Add subscription' }));
      const name = screen.getByLabelText(/Service name/);
      await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
      expect(screen.getAllByText('Name is already taken in your list.').length).toBeGreaterThan(0);
      expect(screen.getByLabelText(/Website/)).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: 'Add subscription' })).toBeEnabled();
      expect(name).toHaveValue('Spotify');
    });

    it('a server failure is shown as a safe form-level message, with the form intact for another try', async () => {
      let n = 0;
      const server = formServer().on('POST', '/api/subscriptions', () => (++n === 1 ? fail(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.') : { status: 201, body: { data: created } }));
      const { user } = renderApp('/subscriptions/new');
      await fillBasics(user);
      await user.click(screen.getByRole('button', { name: 'Add subscription' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
      expect(screen.getByLabelText(/Service name/)).toHaveValue('Spotify');
      await user.click(screen.getByRole('button', { name: 'Add subscription' }));
      expect(await screen.findByRole('heading', { name: 'Spotify', level: 1 })).toBeInTheDocument();
      expect(server.to('POST', '/api/subscriptions')).toHaveLength(2);
    });

    it('a network failure says so (inline and as an announced toast)', async () => {
      const server = formServer();
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') throw new TypeError('Failed to fetch');
        return server.fetch(input, init);
      });
      const { user } = renderApp('/subscriptions/new');
      await fillBasics(user);
      await user.click(screen.getByRole('button', { name: 'Add subscription' }));
      expect((await screen.findAllByText(/Can’t reach SubCycle/)).length).toBeGreaterThanOrEqual(2); // form message + toast
      expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add subscription' })).toBeEnabled();
    });

    it('the subscription limit is explained', async () => {
      formServer().on('POST', '/api/subscriptions', fail(409, 'SUBSCRIPTION_LIMIT_REACHED', 'You can track up to 500 subscriptions.'));
      const { user } = renderApp('/subscriptions/new');
      await fillBasics(user);
      await user.click(screen.getByRole('button', { name: 'Add subscription' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('You can track up to 500 subscriptions.');
    });
  });

  it('prevents duplicate submissions while the request is in flight', async () => {
    const gate = deferred();
    const server = formServer().on('POST', '/api/subscriptions', () => gate.promise);
    const { user } = renderApp('/subscriptions/new');
    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: 'Add subscription' }));
    const busy = screen.getByRole('button', { name: /Saving/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    await user.click(busy);
    await user.keyboard('{Enter}');
    gate.resolve({ status: 201, body: { data: created } });
    await screen.findByRole('heading', { name: 'Spotify', level: 1 });
    expect(server.to('POST', '/api/subscriptions')).toHaveLength(1);
  });

  it('is fully operable from the keyboard: labelled controls, radio arrows, Enter submits', async () => {
    const server = formServer();
    const { user } = renderApp('/subscriptions/new');
    const name = await screen.findByLabelText(/Service name/);
    name.focus();
    await user.keyboard('Spotify');
    await user.tab(); // category
    await user.tab(); // price
    await user.keyboard('119');
    await user.tab(); // currency
    await user.tab(); // frequency radio group (one tab stop)
    expect(screen.getByRole('radio', { name: 'Monthly' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Quarterly' })).toBeChecked();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Monthly' })).toBeChecked();
    await user.tab(); // trial group
    await user.tab(); // next billing date
    await user.keyboard('2030-02-10{Enter}');
    await waitFor(() => expect(server.to('POST', '/api/subscriptions')).toHaveLength(1));
    expect(server.last('POST', '/api/subscriptions')!.body).toMatchObject({ name: 'Spotify', amountMinor: 11900, billingFrequency: 'monthly', nextBillingDate: '2030-02-10' });
  });
});

describe('edit subscription', () => {
  const existing = makeSub({ id: 'e1', name: 'Netflix', amountMinor: 64900, anchorDate: '2030-01-31', nextBillingDate: '2030-02-28', effectiveNextBillingDate: '2030-02-28', notes: 'keep me' });
  const editServer = (sub = existing) => formServer(sub).on('PATCH', '/api/subscriptions/:id', ok(sub));

  it('loads the saved values (not the computed date)', async () => {
    editServer();
    renderApp('/subscriptions/e1/edit');
    expect(await screen.findByLabelText(/Service name/)).toHaveValue('Netflix');
    expect(screen.getByLabelText(/Price per billing period/)).toHaveValue('649.00');
    expect(screen.getByLabelText(/Next billing date/)).toHaveValue('2030-02-28');
    expect(screen.getByLabelText('Notes (optional)')).toHaveValue('keep me');
  });

  it('REGRESSION: changing only the name sends only the name, so a month-end schedule is not reset', async () => {
    const server = editServer();
    const { user } = renderApp('/subscriptions/e1/edit');
    const name = await screen.findByLabelText(/Service name/);
    await user.clear(name);
    await user.type(name, 'Netflix 4K');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(server.to('PATCH', '/api/subscriptions/e1')).toHaveLength(1));
    expect(server.last('PATCH', '/api/subscriptions/e1')!.body).toEqual({ name: 'Netflix 4K' });
    expect(await screen.findByText('Saved changes to Netflix.')).toBeInTheDocument();
  });

  it('saying nothing changed is an error message, not an empty request', async () => {
    const server = editServer();
    const { user } = renderApp('/subscriptions/e1/edit');
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You haven’t changed anything yet.');
    expect(server.to('PATCH', '/api/subscriptions/e1')).toHaveLength(0);
  });

  it('changing the price reveals price-history options; recording is on by default and can be turned off', async () => {
    const server = editServer();
    const { user } = renderApp('/subscriptions/e1/edit');
    const price = await screen.findByLabelText(/Price per billing period/);
    expect(screen.queryByText('Price change')).not.toBeInTheDocument();
    await user.clear(price);
    await user.type(price, '799');
    expect(screen.getByRole('heading', { name: 'Price change' })).toBeInTheDocument();
    expect(screen.getByLabelText('Record this in the price history')).toBeChecked();
    await user.type(screen.getByLabelText('Note (optional)'), 'annual rise');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(server.last('PATCH', '/api/subscriptions/e1')?.body).toEqual({ amountMinor: 79900, priceChangeNote: 'annual rise' }));
  });

  it('unticking "record this" sends it as a correction', async () => {
    const server = editServer();
    const { user } = renderApp('/subscriptions/e1/edit');
    const price = await screen.findByLabelText(/Price per billing period/);
    await user.clear(price);
    await user.type(price, '649.50');
    await user.click(screen.getByLabelText('Record this in the price history'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(server.last('PATCH', '/api/subscriptions/e1')?.body).toEqual({ amountMinor: 64950, recordPriceChange: false }));
  });

  it('changing the frequency sends the next billing date as well, and explains why', async () => {
    const server = editServer();
    const { user } = renderApp('/subscriptions/e1/edit');
    await user.click(await screen.findByRole('radio', { name: 'Yearly' }));
    expect(screen.getByText(/starts a new schedule: confirm the next billing date/)).toBeInTheDocument();
    const date = screen.getByLabelText(/Next billing date/);
    await user.clear(date);
    await user.type(date, '2031-02-28');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(server.last('PATCH', '/api/subscriptions/e1')?.body).toEqual({ billingFrequency: 'yearly', nextBillingDate: '2031-02-28' }));
  });

  it('a saved date that has passed is explained and does not block editing other fields', async () => {
    const stale = makeSub({ id: 'e2', name: 'Stale', nextBillingDate: '2030-01-05', anchorDate: '2030-01-05', effectiveNextBillingDate: '2030-02-05' });
    const server = editServer(stale);
    const { user } = renderApp('/subscriptions/e2/edit');
    expect(await screen.findByText(/has passed\. SubCycle keeps following your billing day/)).toBeInTheDocument();
    const notes = screen.getByLabelText('Notes (optional)');
    await user.type(notes, 'hello');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(server.last('PATCH', '/api/subscriptions/e2')?.body).toEqual({ notes: 'hello' }));
  });

  it('clearing optional fields sends null', async () => {
    const server = editServer();
    const { user } = renderApp('/subscriptions/e1/edit');
    await user.clear(await screen.findByLabelText('Notes (optional)'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(server.last('PATCH', '/api/subscriptions/e1')?.body).toEqual({ notes: null }));
  });

  it('shows a locked currency (409) next to the currency field', async () => {
    editServer().on('PATCH', '/api/subscriptions/:id', fail(409, 'CURRENCY_LOCKED', 'The currency can’t be changed once payments or price changes are recorded.'));
    const { user } = renderApp('/subscriptions/e1/edit');
    await user.selectOptions(await screen.findByLabelText('Currency'), 'USD');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const currency = screen.getByLabelText('Currency');
    await waitFor(() => expect(currency).toHaveAttribute('aria-invalid', 'true'));
    expect(document.getElementById(currency.getAttribute('aria-describedby')!)).toHaveTextContent(/can’t be changed once payments/);
  });

  it('not found and load errors have their own states', async () => {
    signedInServer().on('GET', '/api/subscriptions/:id', fail(404, 'NOT_FOUND', 'Subscription not found.'));
    renderApp('/subscriptions/nope/edit');
    expect(await screen.findByText('Subscription not found')).toBeInTheDocument();
  });
});

describe('per-subscription reminder settings', () => {
  const existing = makeSub({ id: 'r1', name: 'Netflix', reminderLeadDays: 5, remindersEnabled: true });
  const editServer = (sub = existing) => formServer(sub).on('PATCH', '/api/subscriptions/:id', ok(sub));

  it('loads the saved override and shows the default in the hint', async () => {
    editServer();
    renderApp('/subscriptions/r1/edit');
    expect(await screen.findByLabelText(/Days before/)).toHaveValue('5');
    expect(screen.getByLabelText('Remind me before this renews')).toBeChecked();
    expect(screen.getByText(/Leave blank to use your default \(3 days\)/)).toBeInTheDocument();
  });

  it('changing only the lead time sends only reminderLeadDays', async () => {
    const server = editServer();
    const { user } = renderApp('/subscriptions/r1/edit');
    const lead = await screen.findByLabelText(/Days before/);
    await user.clear(lead);
    await user.type(lead, '0');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(server.to('PATCH', '/api/subscriptions/r1')).toHaveLength(1));
    expect(server.last('PATCH', '/api/subscriptions/r1')!.body).toEqual({ reminderLeadDays: 0 });
  });

  it('clearing the override sends null so the account default applies', async () => {
    const server = editServer();
    const { user } = renderApp('/subscriptions/r1/edit');
    await user.clear(await screen.findByLabelText(/Days before/));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(server.to('PATCH', '/api/subscriptions/r1')).toHaveLength(1));
    expect(server.last('PATCH', '/api/subscriptions/r1')!.body).toEqual({ reminderLeadDays: null });
  });

  it('turning reminders off disables the lead field and sends remindersEnabled=false only', async () => {
    const server = editServer();
    const { user } = renderApp('/subscriptions/r1/edit');
    await user.click(await screen.findByLabelText('Remind me before this renews'));
    expect(screen.getByLabelText(/Days before/)).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(server.to('PATCH', '/api/subscriptions/r1')).toHaveLength(1));
    expect(server.last('PATCH', '/api/subscriptions/r1')!.body).toEqual({ remindersEnabled: false });
  });

  it.each(['61', '-2', '1.5', 'x'])('rejects lead %j locally with no request', async (value) => {
    const server = editServer();
    const { user } = renderApp('/subscriptions/r1/edit');
    const lead = await screen.findByLabelText(/Days before/);
    await user.clear(lead);
    await user.type(lead, value);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findAllByText(/0 to 60|between 0 and 60|whole number/i)).length).toBeGreaterThan(0);
    expect(server.to('PATCH', '/api/subscriptions/r1')).toHaveLength(0);
  });

  it('creating a subscription sends reminder fields only when the user set them', async () => {
    const server = formServer();
    const { user } = renderApp('/subscriptions/new');
    await fillBasics(user);
    await user.type(screen.getByLabelText(/Days before/), '2');
    await user.click(screen.getByRole('button', { name: 'Add subscription' }));
    await waitFor(() => expect(server.to('POST', '/api/subscriptions')).toHaveLength(1));
    expect(server.last('POST', '/api/subscriptions')!.body).toMatchObject({ reminderLeadDays: 2 });
  });
});
