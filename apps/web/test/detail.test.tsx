import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, detailServer, fail, freezeTime, makeHistory, makePayment, makeSub, ok, renderApp, signedInServer } from './helpers';

beforeEach(() => freezeTime());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const base = () => makeSub({ id: 's1', name: 'Netflix', cancellationUrl: 'https://www.netflix.com/cancelplan', websiteUrl: 'https://www.netflix.com' });
const dialog = (name: RegExp | string) => screen.getByRole('dialog', { name });

describe('subscription detail', () => {
  describe('what is shown, and how it is labelled', () => {
    it('price, cadence, the monthly equivalent as an ESTIMATE, and the next renewal as a PROJECTION', async () => {
      detailServer({ sub: makeSub({ id: 's1', name: 'Dropbox', amountMinor: 1200000, billingFrequency: 'yearly', currency: 'USD', anchorDate: '2030-06-01', nextBillingDate: '2030-06-01', effectiveNextBillingDate: '2030-06-01' }) });
      renderApp('/subscriptions/s1');
      expect(await screen.findByRole('heading', { name: 'Dropbox', level: 1 })).toBeInTheDocument();
      expect(screen.getAllByText(/12,000\.00/)[0]).toHaveTextContent(/USD/);
      expect(screen.getByText(/per year/)).toBeInTheDocument();
      const billing = within(screen.getByRole('heading', { name: 'Billing' }).closest('section')!);
      const monthly = billing.getByText('Monthly equivalent').closest('div')!;
      expect(within(monthly).getByText('Estimate')).toBeInTheDocument();
      expect(within(monthly).getByText(/1,000\.00/)).toHaveTextContent(/USD/);
      expect(within(monthly).getByText(/not money you paid/)).toBeInTheDocument();
      const next = billing.getByText('Next renewal').closest('div')!;
      expect(within(next).getByText('Projection')).toBeInTheDocument();
    });

    it('a stale saved date: shows the calculated renewal and explains the difference', async () => {
      detailServer({ sub: makeSub({ id: 's1', nextBillingDate: '2030-01-05', anchorDate: '2030-01-05', effectiveNextBillingDate: '2030-02-05' }) });
      renderApp('/subscriptions/s1');
      const next = (await screen.findByText('Next renewal')).closest('div')!;
      expect(next).toHaveTextContent('in 21 days');
      expect(next).toHaveTextContent(/Calculated from your billing schedule\. The saved date \(.*5.*\) hasn’t been updated yet\./);
    });

    it('lists projected renewals as a projection, not a record of charges', async () => {
      detailServer({ sub: base(), upcoming: [{ date: '2030-02-01', amountMinor: 64900, currency: 'INR' }, { date: '2030-03-01', amountMinor: 64900, currency: 'INR' }] });
      renderApp('/subscriptions/s1');
      const section = within((await screen.findByRole('heading', { name: 'Projected renewals' })).closest('section')!);
      expect(await section.findAllByText(/649\.00/)).toHaveLength(2);
      expect(section.getByText('Projection')).toBeInTheDocument();
      expect(section.getByText(/Not a record of charges/)).toBeInTheDocument();
    });

    it('payments are labelled Recorded and clearly user-entered, never "verified"', async () => {
      detailServer({ sub: base(), payments: [makePayment({ subscriptionId: 's1', paidOn: '2030-01-10', forBillingDate: '2030-01-01', note: 'paid by UPI' })] });
      renderApp('/subscriptions/s1');
      const section = within((await screen.findByRole('heading', { name: 'Recorded payments' })).closest('section')!);
      expect(section.getByText('Recorded')).toBeInTheDocument();
      expect(section.getByText(/You record these yourself\. SubCycle doesn’t check them against your bank or Netflix\./)).toBeInTheDocument();
      expect(await section.findByText('paid by UPI')).toBeInTheDocument();
      expect(section.getByText(/For the renewal on/)).toBeInTheDocument();
      expect(document.body).not.toHaveTextContent(/verified|confirmed by/i);
    });

    it('payments keep their own currency, refunds are negative and failed ones struck through', async () => {
      detailServer({
        sub: base(),
        payments: [
          makePayment({ subscriptionId: 's1', currency: 'USD', amountMinor: 799, paidOn: '2030-01-12' }),
          makePayment({ subscriptionId: 's1', amountMinor: 10000, status: 'refunded', paidOn: '2030-01-11' }),
          makePayment({ subscriptionId: 's1', amountMinor: 64900, status: 'failed', paidOn: '2030-01-10' }),
        ],
      });
      renderApp('/subscriptions/s1');
      const section = within((await screen.findByRole('heading', { name: 'Recorded payments' })).closest('section')!);
      const rows = await section.findAllByRole('listitem');
      expect(rows[0]).toHaveTextContent(/7\.99.*USD/);
      expect(rows[1]).toHaveTextContent(/−.*100\.00.*INR/);
      expect(rows[1]).toHaveTextContent('Refunded');
      expect(rows[2]).toHaveTextContent('Failed');
    });

    it('price history shows the recorded changes only', async () => {
      detailServer({ sub: base(), history: [makeHistory({ subscriptionId: 's1', oldAmountMinor: 59900, newAmountMinor: 64900, note: 'annual rise' })] });
      renderApp('/subscriptions/s1');
      const section = within((await screen.findByRole('heading', { name: 'Price history' })).closest('section')!);
      expect(await section.findByText(/599\.00/)).toBeInTheDocument();
      expect(section.getByText(/649\.00/)).toBeInTheDocument();
      expect(section.getByText(/annual rise/)).toBeInTheDocument();
    });

    it('empty payment and price-history sections explain themselves', async () => {
      detailServer({ sub: base() });
      renderApp('/subscriptions/s1');
      expect(await screen.findByText('No payments recorded')).toBeInTheDocument();
      expect(screen.getByText(/No price changes recorded/)).toBeInTheDocument();
    });

    it('the cancellation link opens safely in a new tab and says cancelling happens there', async () => {
      detailServer({ sub: base() });
      renderApp('/subscriptions/s1');
      const link = await screen.findByRole('link', { name: /netflix\.com\/cancelplan/ });
      expect(link).toHaveAttribute('href', 'https://www.netflix.com/cancelplan');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.getAttribute('rel')).toMatch(/noopener/);
      expect(link.getAttribute('rel')).toMatch(/noreferrer/);
      expect(screen.getByText(/Cancelling happens on their site/)).toBeInTheDocument();
    });

    it.each([
      ['paused', { status: 'paused' as const, effectiveNextBillingDate: null }, /not counted in your totals or upcoming renewals/],
      ['cancelled', { status: 'cancelled' as const, cancelledOn: '2030-01-04', effectiveNextBillingDate: null }, /You recorded this cancellation on .*SubCycle can’t confirm it with the provider/],
      ['archived', { status: 'archived' as const, effectiveNextBillingDate: null }, /hidden from lists by default/],
    ])('%s subscriptions say so instead of showing a renewal', async (_n, over, text) => {
      detailServer({ sub: makeSub({ id: 's1', ...over }) });
      renderApp('/subscriptions/s1');
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Projected renewals' })).not.toBeInTheDocument();
    });

    it('an ended trial tells the user to convert or cancel (SubCycle never converts it)', async () => {
      detailServer({ sub: makeSub({ id: 's1', status: 'trial', trialEndDate: '2030-01-10', nextBillingDate: '2030-01-10', effectiveNextBillingDate: '2030-01-10' }) });
      renderApp('/subscriptions/s1');
      expect(await screen.findByText(/SubCycle doesn’t convert trials automatically/)).toBeInTheDocument();
    });
  });

  describe('loading and error states', () => {
    it('loading is announced; not-found and server errors are distinct', async () => {
      const gate = deferred();
      signedInServer().on('GET', '/api/subscriptions/:id', () => gate.promise);
      renderApp('/subscriptions/s1');
      expect(await screen.findByRole('status', { name: 'Loading subscription' })).toBeInTheDocument();
      gate.resolve(fail(404, 'NOT_FOUND', 'Subscription not found.'));
      expect(await screen.findByText('Subscription not found')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Back to subscriptions' })).toHaveAttribute('href', '/subscriptions');
    });

    it('a server error offers Retry', async () => {
      let n = 0;
      const { server } = detailServer({ sub: base() });
      server.on('GET', '/api/subscriptions/:id', () => (++n === 1 ? fail(500, 'INTERNAL_ERROR', 'Something went wrong.') : ok(base())));
      const { user } = renderApp('/subscriptions/s1');
      expect(await screen.findByRole('alert')).toHaveTextContent('We couldn’t load this subscription');
      await user.click(screen.getByRole('button', { name: /try again/i }));
      expect(await screen.findByRole('heading', { name: 'Netflix', level: 1 })).toBeInTheDocument();
    });

    it('a failing payments request does not take the page down', async () => {
      const { server } = detailServer({ sub: base() });
      server.on('GET', '/api/subscriptions/:id/payments', fail(500, 'INTERNAL_ERROR', 'Payments unavailable.'));
      renderApp('/subscriptions/s1');
      expect(await screen.findByText('We couldn’t load payments')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Netflix', level: 1 })).toBeInTheDocument();
    });
  });

  describe('status actions', () => {
    it.each([
      ['active', ['Pause', 'Record cancellation', 'Archive']],
      ['trial', ['Convert trial', 'Record cancellation', 'Archive']],
      ['paused', ['Resume', 'Record cancellation', 'Archive']],
      ['cancelled', ['Archive', 'Restore']],
      ['archived', ['Restore']],
    ] as const)('a %s subscription offers exactly: %j', async (status, labels) => {
      detailServer({ sub: makeSub({ id: 's1', status, ...(status === 'trial' ? { trialEndDate: '2030-02-01' } : {}), ...(status === 'cancelled' ? { cancelledOn: '2030-01-04' } : {}) }) });
      renderApp('/subscriptions/s1');
      const group = within(await screen.findByRole('group', { name: 'Status actions' }));
      expect(group.getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(labels);
    });

    it('pause: asks first, explains it only changes what SubCycle shows, then sends the action and refreshes', async () => {
      const { server, state } = detailServer({ sub: base() });
      server.on('POST', '/api/subscriptions/:id/status', () => {
        state.sub = makeSub({ ...state.sub, status: 'paused', effectiveNextBillingDate: null, allowedActions: ['resume', 'cancel', 'archive'] });
        return ok(state.sub);
      });
      const { user } = renderApp('/subscriptions/s1');
      await user.click(await screen.findByRole('button', { name: 'Pause' }));
      const d = dialog('Pause Netflix?');
      expect(d).toHaveTextContent(/doesn’t pause anything with Netflix/);
      expect(server.to('POST', '/api/subscriptions/s1/status')).toHaveLength(0); // nothing happens until confirmed
      await user.click(within(d).getByRole('button', { name: 'Pause' }));
      await waitFor(() => expect(server.last('POST', '/api/subscriptions/s1/status')?.body).toEqual({ action: 'pause' }));
      expect(await screen.findByText('Paused Netflix.')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect((await screen.findAllByText('Paused')).length).toBeGreaterThan(0); // the page now reflects the new status
      expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    });

    describe('record cancellation: the user’s own status, not a cancellation of the real service', () => {
      it('explains this clearly, links the official page, and sends the cancellation date', async () => {
        const { server, state } = detailServer({ sub: base() });
        server.on('POST', '/api/subscriptions/:id/status', () => ok((state.sub = makeSub({ ...state.sub, status: 'cancelled', cancelledOn: '2030-01-15', effectiveNextBillingDate: null, allowedActions: ['archive', 'restore'] }))));
        const { user } = renderApp('/subscriptions/s1');
        await user.click(await screen.findByRole('button', { name: 'Record cancellation' }));
        const d = dialog('Record that you cancelled Netflix');
        expect(d).toHaveTextContent('SubCycle can’t cancel Netflix for you.');
        expect(d).toHaveTextContent('This only records your own status. It doesn’t contact Netflix');
        const link = within(d).getByRole('link', { name: /Open netflix\.com cancellation page/ });
        expect(link).toHaveAttribute('href', 'https://www.netflix.com/cancelplan');
        expect(link).toHaveAttribute('target', '_blank');
        expect(within(d).getByLabelText('Date you cancelled')).toHaveValue('2030-01-15'); // today, in the user's zone
        await user.click(within(d).getByRole('button', { name: 'Record cancellation' }));
        await waitFor(() => expect(server.last('POST', '/api/subscriptions/s1/status')?.body).toEqual({ action: 'cancel', cancelledOn: '2030-01-15' }));
        expect(await screen.findByText(/SubCycle hasn’t cancelled anything with the provider/)).toBeInTheDocument();
        expect(await screen.findByText(/You recorded this cancellation on/)).toBeInTheDocument();
      });

      it('without a saved link it says so instead of inventing one', async () => {
        detailServer({ sub: makeSub({ id: 's1', websiteUrl: null, cancellationUrl: null }) });
        const { user } = renderApp('/subscriptions/s1');
        await user.click(await screen.findByRole('button', { name: 'Record cancellation' }));
        expect(within(dialog(/Record that you cancelled/)).getByText(/haven’t saved a cancellation link/)).toBeInTheDocument();
        expect(within(dialog(/Record that you cancelled/)).queryByRole('link')).not.toBeInTheDocument();
      });

      it('rejects a future date and a date before the start, without sending anything', async () => {
        const { server } = detailServer({ sub: base() });
        const { user } = renderApp('/subscriptions/s1');
        await user.click(await screen.findByRole('button', { name: 'Record cancellation' }));
        const d = dialog(/Record that you cancelled/);
        const date = within(d).getByLabelText('Date you cancelled');
        await user.clear(date);
        await user.type(date, '2030-01-16');
        await user.click(within(d).getByRole('button', { name: 'Record cancellation' }));
        expect((await within(d).findAllByText(/can’t be in the future/)).length).toBeGreaterThan(0);
        await user.clear(date);
        await user.type(date, '2029-12-31');
        await user.click(within(d).getByRole('button', { name: 'Record cancellation' }));
        expect((await within(d).findAllByText(/can’t be before the start date/)).length).toBeGreaterThan(0);
        expect(server.to('POST', '/api/subscriptions/s1/status')).toHaveLength(0);
      });
    });

    describe('actions that restart billing need a usable date', () => {
      it('resume with a still-current date keeps the schedule: no date is sent', async () => {
        const { server } = detailServer({ sub: makeSub({ id: 's1', status: 'paused', nextBillingDate: '2030-02-01', effectiveNextBillingDate: null }) });
        server.on('POST', '/api/subscriptions/:id/status', ok(makeSub({ id: 's1' })));
        const { user } = renderApp('/subscriptions/s1');
        await user.click(await screen.findByRole('button', { name: 'Resume' }));
        const d = dialog('Resume Netflix?');
        expect(within(d).getByLabelText('Next billing date')).toHaveValue('2030-02-01');
        await user.click(within(d).getByRole('button', { name: 'Resume' }));
        await waitFor(() => expect(server.last('POST', '/api/subscriptions/s1/status')?.body).toEqual({ action: 'resume' }));
      });

      it('resume after the saved date passed suggests the next date on the same schedule and sends it', async () => {
        const { server } = detailServer({ sub: makeSub({ id: 's1', status: 'paused', anchorDate: '2030-01-05', nextBillingDate: '2030-01-05', effectiveNextBillingDate: null }) });
        server.on('POST', '/api/subscriptions/:id/status', ok(makeSub({ id: 's1' })));
        const { user } = renderApp('/subscriptions/s1');
        await user.click(await screen.findByRole('button', { name: 'Resume' }));
        const d = dialog('Resume Netflix?');
        expect(within(d).getByLabelText('Next billing date')).toHaveValue('2030-02-05'); // Jan 5 + 1 month, from the anchor
        expect(d).toHaveTextContent(/has passed, so this is suggested from your billing schedule/);
        await user.click(within(d).getByRole('button', { name: 'Resume' }));
        await waitFor(() => expect(server.last('POST', '/api/subscriptions/s1/status')?.body).toEqual({ action: 'resume', nextBillingDate: '2030-02-05' }));
      });

      it('a past date is refused before sending', async () => {
        const { server } = detailServer({ sub: makeSub({ id: 's1', status: 'paused', anchorDate: '2030-01-05', nextBillingDate: '2030-01-05', effectiveNextBillingDate: null }) });
        const { user } = renderApp('/subscriptions/s1');
        await user.click(await screen.findByRole('button', { name: 'Resume' }));
        const d = dialog('Resume Netflix?');
        const date = within(d).getByLabelText('Next billing date');
        await user.clear(date);
        await user.type(date, '2030-01-14');
        await user.click(within(d).getByRole('button', { name: 'Resume' }));
        expect((await within(d).findAllByText('Next billing date can’t be in the past.')).length).toBeGreaterThan(0);
        expect(server.to('POST', '/api/subscriptions/s1/status')).toHaveLength(0);
      });

      it('convert trial: sends the action (no date needed while the trial date is current)', async () => {
        const { server } = detailServer({ sub: makeSub({ id: 's1', status: 'trial', trialEndDate: '2030-02-01', nextBillingDate: '2030-02-01', effectiveNextBillingDate: '2030-02-01' }) });
        server.on('POST', '/api/subscriptions/:id/status', ok(makeSub({ id: 's1' })));
        const { user } = renderApp('/subscriptions/s1');
        await user.click(await screen.findByRole('button', { name: 'Convert trial' }));
        expect(dialog(/Convert Netflix to a paid subscription/)).toHaveTextContent('SubCycle never converts trials on its own');
        await user.click(within(dialog(/Convert Netflix/)).getByRole('button', { name: 'Convert trial' }));
        await waitFor(() => expect(server.last('POST', '/api/subscriptions/s1/status')?.body).toEqual({ action: 'convert' }));
      });

      it('restoring a CANCELLED subscription requires a confirmed date and sends it', async () => {
        const { server } = detailServer({ sub: makeSub({ id: 's1', status: 'cancelled', cancelledOn: '2030-01-04', anchorDate: '2030-01-05', nextBillingDate: '2030-01-05', effectiveNextBillingDate: null }) });
        server.on('POST', '/api/subscriptions/:id/status', ok(makeSub({ id: 's1' })));
        const { user } = renderApp('/subscriptions/s1');
        await user.click(await screen.findByRole('button', { name: 'Restore' }));
        const d = dialog('Restore Netflix?');
        expect(d).toHaveTextContent(/doesn’t re-subscribe you with Netflix/);
        const date = within(d).getByLabelText('Next billing date');
        expect(date).toHaveValue('2030-02-05');
        await user.clear(date);
        await user.type(date, '2030-02-10');
        await user.click(within(d).getByRole('button', { name: 'Restore' }));
        await waitFor(() => expect(server.last('POST', '/api/subscriptions/s1/status')?.body).toEqual({ action: 'restore', nextBillingDate: '2030-02-10' }));
      });

      it('restoring from the ARCHIVE tries without a date, then asks for one only if the server needs it', async () => {
        const { server } = detailServer({ sub: makeSub({ id: 's1', status: 'archived', anchorDate: '2030-01-05', nextBillingDate: '2030-01-05', effectiveNextBillingDate: null }) });
        let n = 0;
        server.on('POST', '/api/subscriptions/:id/status', () => (++n === 1
          ? fail(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [{ path: 'nextBillingDate', message: 'The stored billing date has passed. Provide the next billing date.' }])
          : ok(makeSub({ id: 's1' }))));
        const { user } = renderApp('/subscriptions/s1');
        await user.click(await screen.findByRole('button', { name: 'Restore' }));
        const d = dialog('Restore Netflix?');
        expect(within(d).queryByLabelText('Next billing date')).not.toBeInTheDocument();
        await user.click(within(d).getByRole('button', { name: 'Restore' }));
        expect(await within(d).findByLabelText('Next billing date')).toHaveValue('2030-02-05');
        expect(d).toHaveTextContent(/saved billing date has passed\. Confirm the next billing date/);
        await user.click(within(d).getByRole('button', { name: 'Restore' }));
        await waitFor(() => expect(server.to('POST', '/api/subscriptions/s1/status')).toHaveLength(2));
        expect(server.calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ action: 'restore' }, { action: 'restore', nextBillingDate: '2030-02-05' }]);
      });
    });

    it('archive explains that nothing is deleted', async () => {
      const { server } = detailServer({ sub: base() });
      server.on('POST', '/api/subscriptions/:id/status', ok(makeSub({ id: 's1', status: 'archived' })));
      const { user } = renderApp('/subscriptions/s1');
      await user.click(await screen.findByRole('button', { name: 'Archive' }));
      expect(dialog('Archive Netflix?')).toHaveTextContent(/nothing is deleted/);
      await user.click(within(dialog('Archive Netflix?')).getByRole('button', { name: 'Archive' }));
      await waitFor(() => expect(server.last('POST', '/api/subscriptions/s1/status')?.body).toEqual({ action: 'archive' }));
    });

    it('an action the server refuses (state changed elsewhere) shows its message in the dialog and refreshes the page', async () => {
      const { server } = detailServer({ sub: base() });
      server.on('POST', '/api/subscriptions/:id/status', fail(409, 'INVALID_TRANSITION', 'A paused subscription can’t be paused. Allowed actions: resume, cancel, archive.'));
      const { user } = renderApp('/subscriptions/s1');
      await user.click(await screen.findByRole('button', { name: 'Pause' }));
      const before = server.to('GET', '/api/subscriptions/s1').length;
      await user.click(within(dialog('Pause Netflix?')).getByRole('button', { name: 'Pause' }));
      expect(await within(dialog('Pause Netflix?')).findByRole('alert')).toHaveTextContent('can’t be paused');
      await waitFor(() => expect(server.to('GET', '/api/subscriptions/s1').length).toBeGreaterThan(before));
    });

    it('cannot be submitted twice while in flight, and the dialog cannot be dismissed mid-request', async () => {
      const gate = deferred();
      const { server } = detailServer({ sub: base() });
      server.on('POST', '/api/subscriptions/:id/status', () => gate.promise);
      const { user } = renderApp('/subscriptions/s1');
      await user.click(await screen.findByRole('button', { name: 'Pause' }));
      const confirm = within(dialog('Pause Netflix?')).getByRole('button', { name: 'Pause' });
      await user.click(confirm);
      expect(confirm).toBeDisabled();
      await user.click(confirm);
      await user.keyboard('{Escape}');
      expect(screen.getByRole('dialog')).toBeInTheDocument(); // Escape is ignored while busy
      expect(within(dialog('Pause Netflix?')).getByRole('button', { name: 'Close dialog' })).toBeDisabled();
      gate.resolve(ok(makeSub({ id: 's1', status: 'paused' })));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(server.to('POST', '/api/subscriptions/s1/status')).toHaveLength(1);
    });
  });

  describe('dialog keyboard and focus behaviour', () => {
    it('focus moves into the dialog, Tab/Shift+Tab stay inside it, Escape closes it and returns focus to the opener', async () => {
      detailServer({ sub: base() });
      const { user } = renderApp('/subscriptions/s1');
      const opener = await screen.findByRole('button', { name: 'Archive' });
      await user.click(opener);
      const d = dialog('Archive Netflix?');
      expect(d).toHaveAttribute('aria-modal', 'true');
      expect(d).toHaveAccessibleDescription(/nothing is deleted/);
      expect(d.contains(document.activeElement)).toBe(true);

      const inside = within(d).getAllByRole('button'); // Close, Keep as it is, Archive
      inside[inside.length - 1]!.focus();
      await user.tab(); // wraps to the first
      expect(inside[0]).toHaveFocus();
      await user.tab({ shift: true }); // wraps back to the last
      expect(inside[inside.length - 1]).toHaveFocus();
      for (let i = 0; i < 6; i++) {
        await user.tab();
        expect(d.contains(document.activeElement)).toBe(true);
      }

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(opener).toHaveFocus();
    });

    it('the rest of the page is inert while a dialog is open, and restored after', async () => {
      detailServer({ sub: base() });
      const { user, container } = renderApp('/subscriptions/s1');
      await user.click(await screen.findByRole('button', { name: 'Archive' }));
      expect(container).toHaveAttribute('inert');
      await user.click(within(dialog('Archive Netflix?')).getByRole('button', { name: 'Keep as it is' }));
      await waitFor(() => expect(container).not.toHaveAttribute('inert'));
    });

    it('clicking the backdrop closes it', async () => {
      detailServer({ sub: base() });
      const { user } = renderApp('/subscriptions/s1');
      await user.click(await screen.findByRole('button', { name: 'Archive' }));
      const backdrop = dialog('Archive Netflix?').parentElement!;
      await user.pointer({ keys: '[MouseLeft]', target: backdrop });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });
  });
});
