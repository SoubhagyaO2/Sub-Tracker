import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, detailServer, fail, freezeTime, makePayment, makeSub, renderApp, type RecordedRequest } from './helpers';

beforeEach(() => freezeTime());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const sub = () => makeSub({ id: 's1', name: 'Netflix', amountMinor: 64900 }); // monthly, next renewal 2030-02-01
const dialog = () => screen.getByRole('dialog', { name: /Record a payment for Netflix/ });
const lastPost = (server: { last: (m: string, p: string) => RecordedRequest | undefined }) => server.last('POST', '/api/subscriptions/s1/payments');

async function openDialog(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Record payment' }));
  return within(dialog());
}

/** Server whose POST /payments appends a payment (as the real API does) and echoes the advanced subscription. */
function paymentsServer(init: Parameters<typeof detailServer>[0] = { sub: sub() }, advanceTo?: string) {
  const ctx = detailServer(init);
  ctx.server.on('POST', '/api/subscriptions/:id/payments', (req) => {
    const b = req.body as { amountMinor: number; currency: string; paidOn: string; status: 'paid' | 'failed' | 'refunded'; forBillingDate?: string; note?: string };
    const payment = makePayment({ subscriptionId: 's1', amountMinor: b.amountMinor, currency: b.currency as 'INR', paidOn: b.paidOn, status: b.status, forBillingDate: b.forBillingDate ?? null, note: b.note ?? null });
    ctx.state.payments.unshift(payment);
    if (advanceTo) ctx.state.sub = makeSub({ ...ctx.state.sub, nextBillingDate: advanceTo, effectiveNextBillingDate: advanceTo });
    return { status: 201, body: { data: { payment, subscription: ctx.state.sub, nextBillingDateAdvanced: Boolean(advanceTo) } } };
  });
  return ctx;
}

describe('recording a payment', () => {
  it('opens with sensible defaults, and says the record is the user’s own', async () => {
    paymentsServer();
    const { user } = renderApp('/subscriptions/s1');
    const d = await openDialog(user);
    expect(dialog()).toHaveAccessibleDescription(/doesn’t check it against your bank or the provider/);
    expect(d.getByLabelText('Amount paid')).toHaveValue('649.00');
    expect(d.getByLabelText('Currency')).toHaveValue('INR');
    expect(d.getByLabelText('Paid on')).toHaveValue('2030-01-15'); // today in the user's zone
    expect(d.getByRole('radio', { name: 'Paid' })).toBeChecked();
    expect(d.getByLabelText('Which renewal does this cover?')).toHaveValue('2030-02-01'); // the upcoming renewal
    expect(d.getByRole('option', { name: /\(next renewal\)/ })).toBeInTheDocument();
    expect(d.getByLabelText(/Move the next billing date forward/)).toBeChecked();
  });

  it('sends forBillingDate (so the duplicate guard works) and advances the date; success is confirmed and the page refreshes', async () => {
    const { server } = paymentsServer({ sub: sub() }, '2030-03-01');
    const { user } = renderApp('/subscriptions/s1');
    const d = await openDialog(user);
    await user.click(d.getByRole('button', { name: 'Record payment' }));

    await waitFor(() => expect(lastPost(server)?.body).toEqual({
      amountMinor: 64900, currency: 'INR', paidOn: '2030-01-15', status: 'paid', forBillingDate: '2030-02-01', advanceNextBillingDate: true,
    }));
    expect(await screen.findByText(/Payment recorded\. Next billing date moved to .*Mar/)).toBeInTheDocument(); // locale-neutral date text
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // the list refreshed from the server, and the subscription's renewal moved
    const list = within((await screen.findByRole('heading', { name: 'Recorded payments' })).closest('section')!);
    expect(await list.findByText(/649\.00/)).toBeInTheDocument();
    expect((await screen.findByText('Next renewal')).closest('div')).toHaveTextContent(/Mar/);
    expect(lastPost(server)!.headers.get('X-SubCycle-Client')).toBe('web');
  });

  it('a stale saved date defaults to the CALCULATED upcoming renewal, with earlier renewals available', async () => {
    paymentsServer({ sub: makeSub({ id: 's1', name: 'Netflix', anchorDate: '2030-01-05', nextBillingDate: '2030-01-05', effectiveNextBillingDate: '2030-02-05' }) });
    const { user } = renderApp('/subscriptions/s1');
    const d = await openDialog(user);
    const select = d.getByLabelText('Which renewal does this cover?');
    expect(select).toHaveValue('2030-02-05');
    const options = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['', '2030-02-05', '2030-01-05']); // not tied, upcoming, then earlier renewals since the anchor
  });

  it('un-ticking "move the date" sends no advance flag; the other fields are unaffected', async () => {
    const { server } = paymentsServer();
    const { user } = renderApp('/subscriptions/s1');
    const d = await openDialog(user);
    await user.click(d.getByLabelText(/Move the next billing date forward/));
    await user.type(d.getByLabelText(/Note/), 'paid by UPI');
    await user.click(d.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(lastPost(server)?.body).toEqual({
      amountMinor: 64900, currency: 'INR', paidOn: '2030-01-15', status: 'paid', forBillingDate: '2030-02-01', note: 'paid by UPI',
    }));
  });

  describe('when advancing the date does not apply', () => {
    it('a payment not tied to a renewal cannot advance anything', async () => {
      const { server } = paymentsServer();
      const { user } = renderApp('/subscriptions/s1');
      const d = await openDialog(user);
      await user.selectOptions(d.getByLabelText('Which renewal does this cover?'), '');
      const box = d.getByLabelText(/Move the next billing date forward/);
      expect(box).toBeDisabled();
      expect(box).not.toBeChecked();
      expect(d.getByText(/Choose which renewal this covers to enable this/)).toBeInTheDocument();
      await user.click(d.getByRole('button', { name: 'Record payment' }));
      await waitFor(() => expect(lastPost(server)?.body).not.toHaveProperty('forBillingDate'));
      expect(lastPost(server)?.body).not.toHaveProperty('advanceNextBillingDate');
    });

    it('a failed or refunded payment cannot advance the date', async () => {
      paymentsServer();
      const { user } = renderApp('/subscriptions/s1');
      const d = await openDialog(user);
      await user.click(d.getByRole('radio', { name: 'Failed' }));
      expect(d.getByLabelText(/Move the next billing date forward/)).toBeDisabled();
      expect(d.getByText(/Only available for a paid payment/)).toBeInTheDocument();
      await user.click(d.getByRole('radio', { name: 'Paid' }));
      expect(d.getByLabelText(/Move the next billing date forward/)).toBeEnabled();
    });

    it.each(['paused', 'cancelled', 'archived'] as const)('a %s subscription: defaults to "not tied", advance is unavailable, payments can still be recorded', async (status) => {
      const { server } = paymentsServer({ sub: makeSub({ id: 's1', name: 'Netflix', status, effectiveNextBillingDate: null, ...(status === 'cancelled' ? { cancelledOn: '2030-01-04' } : {}) }) });
      const { user } = renderApp('/subscriptions/s1');
      const d = await openDialog(user);
      expect(d.getByLabelText('Which renewal does this cover?')).toHaveValue('');
      expect(d.getByLabelText(/Move the next billing date forward/)).toBeDisabled();
      expect(d.getByText(/Only available for an active subscription/)).toBeInTheDocument();
      await user.click(d.getByRole('button', { name: 'Record payment' }));
      await waitFor(() => expect(lastPost(server)?.body).toMatchObject({ amountMinor: 64900, status: 'paid' }));
    });
  });

  describe('currency', () => {
    it('a payment in another currency is recorded as entered, with a note that nothing is converted', async () => {
      const { server } = paymentsServer();
      const { user } = renderApp('/subscriptions/s1');
      const d = await openDialog(user);
      await user.selectOptions(d.getByLabelText('Currency'), 'USD');
      expect(d.getByText(/differs from the subscription’s currency \(INR\).*nothing is converted/)).toBeInTheDocument();
      const amount = d.getByLabelText('Amount paid');
      await user.clear(amount);
      await user.type(amount, '7.99');
      await user.click(d.getByRole('button', { name: 'Record payment' }));
      await waitFor(() => expect(lastPost(server)?.body).toMatchObject({ currency: 'USD', amountMinor: 799 }));
    });

    it('decimals are validated against the chosen currency', async () => {
      const { server } = paymentsServer();
      const { user } = renderApp('/subscriptions/s1');
      const d = await openDialog(user);
      await user.selectOptions(d.getByLabelText('Currency'), 'JPY');
      await user.click(d.getByRole('button', { name: 'Record payment' })); // 649.00 has decimals: not allowed in JPY
      expect((await d.findAllByText(/JPY has no decimal places/)).length).toBeGreaterThan(0);
      expect(server.to('POST', '/api/subscriptions/s1/payments')).toHaveLength(0);
    });
  });

  describe('validation', () => {
    it('refuses an invalid amount and a future date, tying each error to its field, and sends nothing', async () => {
      const { server } = paymentsServer();
      const { user } = renderApp('/subscriptions/s1');
      const d = await openDialog(user);
      const amount = d.getByLabelText('Amount paid');
      await user.clear(amount);
      await user.type(amount, 'abc');
      const paid = d.getByLabelText('Paid on');
      await user.clear(paid);
      await user.type(paid, '2030-01-16');
      await user.click(d.getByRole('button', { name: 'Record payment' }));
      const summary = await d.findByRole('alert');
      expect(within(summary).getByText(/digits and an optional decimal point/)).toBeInTheDocument();
      expect(within(summary).getByText(/can’t be dated in the future/)).toBeInTheDocument();
      expect(amount).toHaveAttribute('aria-invalid', 'true');
      expect(paid).toHaveAttribute('aria-invalid', 'true');
      expect(server.to('POST', '/api/subscriptions/s1/payments')).toHaveLength(0);
      await waitFor(() => expect(amount).toHaveFocus());
    });

    it('today is accepted as the paid date (boundary)', async () => {
      const { server } = paymentsServer();
      const { user } = renderApp('/subscriptions/s1');
      const d = await openDialog(user);
      await user.click(d.getByRole('button', { name: 'Record payment' }));
      await waitFor(() => expect(lastPost(server)?.body).toMatchObject({ paidOn: '2030-01-15' }));
    });

    it('card numbers in the note are refused before sending', async () => {
      const { server } = paymentsServer();
      const { user } = renderApp('/subscriptions/s1');
      const d = await openDialog(user);
      await user.type(d.getByLabelText(/Note/), '4111 1111 1111 1111');
      await user.click(d.getByRole('button', { name: 'Record payment' }));
      expect((await d.findAllByText(/Don’t enter card numbers/)).length).toBeGreaterThan(0);
      expect(server.to('POST', '/api/subscriptions/s1/payments')).toHaveLength(0);
    });
  });

  describe('server-side responses', () => {
    it('recording the same renewal twice: the duplicate is explained next to "Which renewal", and the dialog stays open', async () => {
      const { server } = paymentsServer();
      server.on('POST', '/api/subscriptions/:id/payments', fail(409, 'DUPLICATE_PAYMENT_PERIOD', 'A paid payment is already recorded for the 2030-02-01 renewal.'));
      const { user } = renderApp('/subscriptions/s1');
      const d = await openDialog(user);
      await user.click(d.getByRole('button', { name: 'Record payment' }));
      const select = d.getByLabelText('Which renewal does this cover?');
      await waitFor(() => expect(select).toHaveAttribute('aria-invalid', 'true'));
      expect(document.getElementById(select.getAttribute('aria-describedby')!.split(' ').at(-1)!)).toHaveTextContent('A paid payment is already recorded for the 2030-02-01 renewal.');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(d.getByRole('button', { name: 'Record payment' })).toBeEnabled();
    });

    it('422 details are shown on their fields; other failures are a safe form-level message', async () => {
      const { server } = paymentsServer();
      let n = 0;
      server.on('POST', '/api/subscriptions/:id/payments', () => (++n === 1
        ? fail(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [{ path: 'forBillingDate', message: 'Can’t advance past the next upcoming renewal (2030-02-01).' }])
        : fail(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.')));
      const { user } = renderApp('/subscriptions/s1');
      const d = await openDialog(user);
      await user.click(d.getByRole('button', { name: 'Record payment' }));
      expect((await d.findAllByText(/Can’t advance past the next upcoming renewal/)).length).toBeGreaterThan(0);
      await user.click(d.getByRole('button', { name: 'Record payment' }));
      expect(await d.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
      expect(d.getByLabelText('Amount paid')).toHaveValue('649.00'); // nothing lost
    });

    it('cannot be submitted twice while in flight (button and Enter), and Escape is ignored meanwhile', async () => {
      const gate = deferred();
      const { server } = paymentsServer();
      server.on('POST', '/api/subscriptions/:id/payments', () => gate.promise);
      const { user } = renderApp('/subscriptions/s1');
      const d = await openDialog(user);
      await user.click(d.getByRole('button', { name: 'Record payment' }));
      const busy = d.getByRole('button', { name: /Recording/ });
      expect(busy).toBeDisabled();
      await user.click(busy);
      await user.keyboard('{Enter}{Escape}');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      gate.resolve({ status: 201, body: { data: { payment: makePayment(), subscription: sub(), nextBillingDateAdvanced: false } } });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(server.to('POST', '/api/subscriptions/s1/payments')).toHaveLength(1);
    });
  });

  it('is operable from the keyboard: the first field is focused, Enter submits, Escape cancels with focus restored', async () => {
    const { server } = paymentsServer();
    const { user } = renderApp('/subscriptions/s1');
    const opener = await screen.findByRole('button', { name: 'Record payment' });
    await user.click(opener);
    expect(within(dialog()).getByLabelText('Amount paid')).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(server.to('POST', '/api/subscriptions/s1/payments')).toHaveLength(0);

    await user.click(opener);
    await user.keyboard('{Enter}'); // Enter in the focused amount field submits the form
    await waitFor(() => expect(server.to('POST', '/api/subscriptions/s1/payments')).toHaveLength(1));
  });
});

describe('payment history list', () => {
  it('pages through payments with the documented page parameters', async () => {
    const payments = Array.from({ length: 25 }, (_, i) => makePayment({ subscriptionId: 's1', paidOn: `2029-12-${String(i + 1).padStart(2, '0')}`, amountMinor: 1000 + i }));
    const { server } = detailServer({ sub: sub(), payments });
    const { user } = renderApp('/subscriptions/s1');
    const nav = await screen.findByRole('navigation', { name: 'Payments pagination' });
    expect(within(nav).getByText(/Page 1 of 3/)).toBeInTheDocument();
    await user.click(within(nav).getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(server.last('GET', '/api/subscriptions/s1/payments')?.query.get('page')).toBe('2'));
    expect(server.last('GET', '/api/subscriptions/s1/payments')?.query.get('pageSize')).toBe('10');
  });
});

describe('deleting a payment record', () => {
  const withPayment = () => {
    const payment = makePayment({ id: 'pay1', subscriptionId: 's1', amountMinor: 64900, paidOn: '2030-01-10' });
    return { ...detailServer({ sub: sub(), payments: [payment] }), payment };
  };

  it('asks for confirmation, states that the billing date is unchanged, then deletes and refreshes', async () => {
    const { server, state } = withPayment();
    server.on('DELETE', '/api/subscriptions/:id/payments/:pid', () => {
      state.payments.length = 0;
      return { status: 204 };
    });
    const { user } = renderApp('/subscriptions/s1');
    await user.click(await screen.findByRole('button', { name: /Delete payment of .*649\.00.*INR.* on /i }));
    const d = screen.getByRole('dialog', { name: 'Delete this payment record?' });
    expect(d).toHaveTextContent(/doesn’t change your next billing date/);
    expect(server.to('DELETE', /payments/)).toHaveLength(0); // nothing yet
    await user.click(within(d).getByRole('button', { name: 'Delete payment' }));
    await waitFor(() => expect(server.to('DELETE', '/api/subscriptions/s1/payments/pay1')).toHaveLength(1));
    expect(await screen.findByText(/Payment record removed\. Your billing date was not changed\./)).toBeInTheDocument();
    expect(await screen.findByText('No payments recorded')).toBeInTheDocument();
    expect(server.last('DELETE', /payments/)!.headers.get('X-SubCycle-Client')).toBe('web');
  });

  it('Cancel leaves everything as it was', async () => {
    const { server } = withPayment();
    const { user } = renderApp('/subscriptions/s1');
    await user.click(await screen.findByRole('button', { name: /Delete payment of/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(server.to('DELETE', /payments/)).toHaveLength(0);
    const list = within(screen.getByRole('heading', { name: 'Recorded payments' }).closest('section')!);
    expect(list.getByText(/649\.00/)).toBeInTheDocument(); // the record is still there
  });

  it('a failure is shown inside the dialog and can be retried', async () => {
    const { server, state } = withPayment();
    let n = 0;
    server.on('DELETE', '/api/subscriptions/:id/payments/:pid', () => {
      if (++n === 1) return fail(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
      state.payments.length = 0;
      return { status: 204 };
    });
    const { user } = renderApp('/subscriptions/s1');
    await user.click(await screen.findByRole('button', { name: /Delete payment of/i }));
    const d = screen.getByRole('dialog');
    await user.click(within(d).getByRole('button', { name: 'Delete payment' }));
    expect(await within(d).findByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
    await user.click(within(d).getByRole('button', { name: 'Delete payment' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(server.to('DELETE', /payments/)).toHaveLength(2);
  });
});

describe('deleting a subscription', () => {
  it('warns what is removed (including the number of recorded payments), deletes, and returns to the list', async () => {
    const { server } = detailServer({ sub: sub(), payments: [makePayment({ subscriptionId: 's1' }), makePayment({ subscriptionId: 's1' })] });
    server.on('DELETE', '/api/subscriptions/:id', { status: 204 });
    const { user } = renderApp('/subscriptions/s1');
    expect(await screen.findByText(/its 2 recorded payments/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Netflix' }));
    const d = screen.getByRole('dialog', { name: 'Delete Netflix?' });
    expect(d).toHaveTextContent(/permanently removes the subscription, its recorded payments and its price history/);
    await user.click(within(d).getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByRole('heading', { name: 'Subscriptions', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Deleted Netflix.')).toBeInTheDocument();
    expect(server.to('DELETE', '/api/subscriptions/s1')).toHaveLength(1);
  });

  it('a failed delete keeps the user on the page with the reason', async () => {
    const { server } = detailServer({ sub: sub() });
    server.on('DELETE', '/api/subscriptions/:id', fail(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.'));
    const { user } = renderApp('/subscriptions/s1');
    await user.click(await screen.findByRole('button', { name: 'Delete Netflix' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete permanently' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('Something went wrong.');
    expect(screen.getByRole('heading', { name: 'Netflix', level: 1 })).toBeInTheDocument();
  });
});
