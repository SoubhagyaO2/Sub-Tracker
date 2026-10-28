import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarOccurrence, CalendarResponseMeta } from '@subcycle/shared';
import { deferred, fail, freezeTime, ok, renderApp, signedInServer, TODAY } from './helpers';

beforeEach(() => freezeTime());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The totals text is split across spans, so match the paragraph's combined text. */
const para = (re: RegExp) => (_: string, el: Element | null) => el?.tagName === 'P' && re.test(el.textContent ?? '');

const occ = (over: Partial<CalendarOccurrence> = {}): CalendarOccurrence => ({
  date: '2030-01-20', kind: 'renewal', subscriptionId: 's1', name: 'Netflix', category: 'video', icon: null,
  amountMinor: 64900, currency: 'INR', billingFrequency: 'monthly', status: 'active', ...over,
});

const metaFor = (items: CalendarOccurrence[], over: Partial<CalendarResponseMeta> = {}): CalendarResponseMeta => {
  const charges = items.filter((o) => o.kind === 'renewal');
  const totals = [...new Set(charges.map((o) => o.currency))].map((currency) => ({
    currency,
    renewalCount: charges.filter((o) => o.currency === currency).length,
    amountMinor: charges.filter((o) => o.currency === currency).reduce((n, o) => n + o.amountMinor, 0),
  }));
  return {
    from: TODAY, to: '2030-01-31', today: TODAY, timeZone: 'Asia/Kolkata', kind: 'projection', total: items.length, truncated: false,
    totals, trialEndCount: items.length - charges.length, ...over,
  };
};

function calendarServer(items: CalendarOccurrence[], over: Partial<CalendarResponseMeta> = {}) {
  return signedInServer().on('GET', '/api/calendar/renewals', (req) => {
    const from = req.query.get('from') ?? '';
    const to = req.query.get('to') ?? '';
    const inRange = items.filter((o) => o.date >= from && o.date <= to);
    return ok(inRange, metaFor(inRange, over));
  });
}

describe('calendar page', () => {
  it('requests the current month on load and labels the figures as a projection', async () => {
    const server = calendarServer([occ()]);
    renderApp('/calendar');
    await screen.findByText(para(/^1 renewal/));
    const call = server.to('GET', '/api/calendar/renewals')[0]!;
    expect(call.query.get('from')).toBe('2030-01-01');
    expect(call.query.get('to')).toBe('2030-01-31');
    expect(call.method).toBe('GET');
    expect(screen.getAllByText('Projection').length).toBeGreaterThan(0);
    expect(screen.getByText(/expected dates, not confirmed charges/i)).toBeInTheDocument();
  });

  it('marks days with renewals in the grid and lists the selected day', async () => {
    calendarServer([occ({ name: 'Netflix' }), occ({ subscriptionId: 's2', name: 'Spotify', amountMinor: 11900 })]);
    const { user } = renderApp('/calendar');
    const day = await screen.findByRole('button', { name: /(20 Jan|Jan 20).*2 renewals/ });
    await user.click(day);
    const panel = within(screen.getByRole('heading', { name: /Sun, (20 Jan|Jan 20)/, level: 2 }).closest('section')!);
    expect(panel.getByText('Netflix')).toBeInTheDocument();
    expect(panel.getByText('Spotify')).toBeInTheDocument();
    expect(panel.getAllByText('Renewal', { exact: false }).length).toBeGreaterThanOrEqual(2);
  });

  it('totals stay per currency and are never blended', async () => {
    calendarServer([occ({ amountMinor: 64900 }), occ({ subscriptionId: 's2', name: 'iCloud', amountMinor: 1000, currency: 'USD' })]);
    renderApp('/calendar');
    await screen.findAllByText(para(/^1 renewal/));
    expect(document.body).toHaveTextContent(/649\.00.*INR/);
    expect(document.body).toHaveTextContent(/10\.00.*USD/);
    expect(document.body).not.toHaveTextContent(/659\.00/);
  });

  it('a free-trial ending is shown as a trial event with no charge counted', async () => {
    calendarServer([occ({ kind: 'trial_end', name: 'Free trial', status: 'trial', date: '2030-01-22', amountMinor: 29900 })]);
    const { user } = renderApp('/calendar');
    await screen.findByText(/1 free trial ends \(no charge counted yet\)/);
    expect(screen.getByText('No renewals in this range.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /22.*1 trial ending/ }));
    expect(screen.getByText(/^Free trial ends/)).toBeInTheDocument();
    expect(screen.getByText('charged after the trial')).toBeInTheDocument();
  });

  it('past days say nothing is projected instead of inventing history', async () => {
    const { user } = (calendarServer([]), renderApp('/calendar'));
    const past = await screen.findAllByRole('button', { name: /past: not projected/ });
    await user.click(past[0]!);
    expect(screen.getByText(/doesn’t show or guess what happened on past dates/)).toBeInTheDocument();
  });

  it('cannot navigate to a past month', async () => {
    calendarServer([]);
    renderApp('/calendar');
    await screen.findByRole('grid');
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();
  });

  it('next month / Today buttons re-request the right range', async () => {
    const server = calendarServer([]);
    const { user } = renderApp('/calendar');
    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    await screen.findByRole('heading', { name: 'February 2030' });
    const last = server.last('GET', '/api/calendar/renewals')!;
    expect(last.query.get('from')).toBe('2030-02-01');
    expect(last.query.get('to')).toBe('2030-02-28');
    await user.click(screen.getByRole('button', { name: 'Today' }));
    await screen.findByRole('heading', { name: 'January 2030' });
  });

  it('arrow keys move the selected day; PageDown changes month; the grid has a single tab stop', async () => {
    calendarServer([]);
    const { user } = renderApp('/calendar');
    const grid = await screen.findByRole('grid');
    const stops = () => within(grid).getAllByRole('button').filter((b) => b.getAttribute('tabindex') === '0');
    expect(stops()).toHaveLength(1);
    expect(stops()[0]).toHaveAccessibleName(/15/);
    stops()[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(stops()[0]).toHaveAccessibleName(/16/);
    expect(stops()[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(stops()[0]).toHaveAccessibleName(/23/);
    await user.keyboard('{PageDown}');
    await screen.findByRole('heading', { name: 'February 2030' });
    expect(stops()).toHaveLength(1);
    await user.keyboard('{PageUp}');
    await screen.findByRole('heading', { name: 'January 2030' });
    await user.keyboard('{PageUp}'); // cannot go to the past
    expect(screen.getByRole('heading', { name: 'January 2030' })).toBeInTheDocument();
  });

  it('the 30-day view groups by date and requests today..today+30', async () => {
    const server = calendarServer([occ({ date: '2030-01-20' }), occ({ date: '2030-02-10', subscriptionId: 's2', name: 'Spotify' })]);
    const { user } = renderApp('/calendar');
    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: '30 days' }));
    await screen.findByRole('heading', { name: 'Upcoming' });
    const call = server.last('GET', '/api/calendar/renewals')!;
    expect(call.query.get('from')).toBe(TODAY);
    expect(call.query.get('to')).toBe('2030-02-14');
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(await screen.findByText('Spotify')).toBeInTheDocument();
  });

  it('weekly subscriptions appear once per occurrence', async () => {
    const weekly = ['2030-01-17', '2030-01-24', '2030-01-31'].map((date) => occ({ date, name: 'Weekly box', billingFrequency: 'weekly', amountMinor: 10000 }));
    const { user } = (calendarServer(weekly), renderApp('/calendar'));
    await screen.findByText(para(/^3 renewals/));
    await user.click(screen.getByRole('button', { name: '30 days' }));
    expect(await screen.findAllByText('Weekly box')).toHaveLength(3);
  });

  it('empty list view explains who does not renew', async () => {
    calendarServer([]);
    const { user } = renderApp('/calendar');
    await screen.findByRole('grid');
    await user.click(screen.getByRole('button', { name: '7 days' }));
    expect(await screen.findByText('Nothing in the next 7 days')).toBeInTheDocument();
    expect(screen.getByText(/Paused, cancelled and archived ones don’t/)).toBeInTheDocument();
  });

  it('warns when the occurrence cap truncated the list, and says totals still include everything', async () => {
    calendarServer([occ()], { truncated: true, total: 1500 });
    renderApp('/calendar');
    expect(await screen.findByText(/Showing the first 1000 of 1500 entries/)).toBeInTheDocument();
    expect(screen.getByText(/Totals above include all of them/)).toBeInTheDocument();
  });

  it('shows a loading region, then recovers from an error with Retry', async () => {
    const gate = deferred();
    const server = signedInServer().on('GET', '/api/calendar/renewals', () => gate.promise);
    renderApp('/calendar');
    expect((await screen.findAllByRole('status', { name: /Loading/ })).length).toBeGreaterThan(0);
    gate.resolve(fail(500, 'INTERNAL_ERROR', 'Something went wrong.'));
    expect(await screen.findByText('We couldn’t load your calendar')).toBeInTheDocument();
    server.on('GET', '/api/calendar/renewals', ok([occ()], metaFor([occ()])));
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.setup().click(screen.getByRole('button', { name: /Try again|Retry/ }));
    expect(await screen.findByText(para(/^1 renewal/))).toBeInTheDocument();
  });
});
