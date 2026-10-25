import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { fetchRecordedPayments, RECORDED_SUBSCRIPTION_CAP } from '../api/aggregate';
import { fetchAllSubscriptions } from '../api/endpoints';
import { CategoryBars, MonthlyBars } from '../components/charts';
import { LinkButton } from '../components/ui/Button';
import { Card, CardHeader, DateText, EmptyState, ErrorState, KindTag, LoadingRegion, Money, ServiceIcon, Skeleton } from '../components/ui/display';
import { SelectField } from '../components/ui/Field';
import { Icon } from '../components/ui/Icon';
import { activeTotals, categoryBreakdown, recentPayments, recordedByMonth, recordedCurrencies, renewalAmounts, upcomingRenewals } from '../lib/dashboard';
import { greetingFor, todayIn, formatDate } from '../lib/dates';
import { FREQUENCY_UNIT, PAYMENT_STATUS_LABEL } from '../lib/labels';
import { orderCurrencies } from '../lib/money';
import { useApi } from '../state/data';
import { useSession } from '../state/auth';
import { usePageTitle, useToday } from '../state/ui';

function Kpi({ id, label, kind, children }: { id: string; label: string; kind?: 'estimate' | 'projection'; children: ReactNode }) {
  return (
    <Card aria-labelledby={id}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={id} className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</h2>
        {kind ? <KindTag kind={kind} /> : null}
      </div>
      <div className="mt-3 space-y-1">{children}</div>
    </Card>
  );
}

/** One line per currency: the preferred one large, the rest smaller. Currencies are never summed together. */
function CurrencyLines({ rows }: { rows: { currency: string; minor: number }[] }) {
  return (
    <>
      {rows.map((r, i) => (
        <p key={r.currency} className={i === 0 ? 'text-2xl font-semibold text-accent-text sm:text-3xl' : 'text-lg font-semibold text-fg'}>
          <Money minor={r.minor} currency={r.currency} className="!whitespace-normal break-words" />
        </p>
      ))}
    </>
  );
}

function CurrencyPicker({ id, currencies, value, onChange }: { id: string; currencies: string[]; value: string; onChange: (c: string) => void }) {
  if (currencies.length < 2) return null;
  return (
    <div className="mb-3 max-w-[11rem]">
      <SelectField name={id} label="Currency" value={value} onChange={(e) => onChange(e.target.value)} options={currencies.map((c) => ({ value: c, label: c }))} />
    </div>
  );
}

export function DashboardPage() {
  usePageTitle('Home');
  const { user, preferences } = useSession();
  const today = useToday();
  const [windowDays, setWindowDays] = useState<7 | 30 | 90>(30);
  const [catCurrency, setCatCurrency] = useState<string | null>(null);
  const [recCurrency, setRecCurrency] = useState<string | null>(null);

  const subsQ = useApi((signal) => fetchAllSubscriptions(signal), []);
  const subs = subsQ.status === 'ready' ? subsQ.data : undefined;
  const idsKey = subs?.map((s) => s.id).join(',') ?? '';
  const payQ = useApi((signal) => fetchRecordedPayments(subs!, today, signal), [idsKey, today], { enabled: subs !== undefined && subs.length > 0 });

  const view = useMemo(() => {
    if (!subs) return null;
    const totals = activeTotals(subs, preferences.currency);
    const week = upcomingRenewals(subs, today, 7);
    const list = upcomingRenewals(subs, today, windowDays);
    const counts = { active: 0, trial: 0, paused: 0 };
    for (const s of subs) if (s.status === 'active' || s.status === 'trial' || s.status === 'paused') counts[s.status]++;
    const recent = [...subs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
    return { totals, week, weekAmounts: renewalAmounts(week, preferences.currency), list, counts, recent };
  }, [subs, today, windowDays, preferences.currency]);

  if (subsQ.status === 'error') {
    return (
      <>
        <h1 className="mb-6 text-2xl">Home</h1>
        <ErrorState error={subsQ.error} onRetry={subsQ.retry} title="We couldn’t load your subscriptions" level={2} />
      </>
    );
  }

  if (subsQ.status !== 'ready' || !view || !subs) {
    return (
      <LoadingRegion label="Loading your dashboard">
        <h1 className="mb-6 text-2xl">Home</h1>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32" />)}
        </div>
        <Skeleton className="mt-4 h-64" />
      </LoadingRegion>
    );
  }

  const greeting = `${greetingFor(preferences.timezone)}, ${user.displayName.split(' ')[0]}`;

  if (subs.length === 0) {
    return (
      <>
        <h1 className="mb-6 text-2xl">{greeting}</h1>
        <EmptyState
          icon="plus"
          title="Nothing tracked yet"
          level={2}
          action={<LinkButton to="/subscriptions/new" variant="primary"><Icon name="plus" className="h-4 w-4" />Add subscription</LinkButton>}
        >
          Add your first subscription to see your monthly picture. SubCycle only knows what you enter: it never connects to your bank or to the services you pay.
        </EmptyState>
      </>
    );
  }

  const catCurrencies = orderCurrencies(view.totals.map((t) => t.currency), preferences.currency);
  const catCur = catCurrency && catCurrencies.includes(catCurrency) ? catCurrency : catCurrencies[0];
  const records = payQ.status === 'ready' ? payQ.data : undefined;
  const recCurrencies = records ? recordedCurrencies(records.payments, preferences.currency) : [];
  const recCur = recCurrency && recCurrencies.includes(recCurrency) ? recCurrency : recCurrencies[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl">{greeting}</h1>
          <p className="mt-1 text-sm text-muted">Here’s your subscription picture. Figures labelled Estimate or Projection are calculated, not money you paid.</p>
        </div>
        <LinkButton to="/subscriptions/new" variant="primary"><Icon name="plus" className="h-4 w-4" />Add subscription</LinkButton>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Summary">
        <Kpi id="kpi-monthly" label="Monthly equivalent" kind="estimate">
          {view.totals.length ? <CurrencyLines rows={view.totals.map((t) => ({ currency: t.currency, minor: t.monthlyEquivalentMinor }))} /> : <p className="text-sm text-muted">No active subscriptions.</p>}
          {view.totals.length ? <p className="text-xs text-muted">Active subscriptions at today’s prices, per currency.</p> : null}
        </Kpi>
        <Kpi id="kpi-annual" label="Annualized cost" kind="projection">
          {view.totals.length ? <CurrencyLines rows={view.totals.map((t) => ({ currency: t.currency, minor: t.annualizedMinor }))} /> : <p className="text-sm text-muted">No active subscriptions.</p>}
          {view.totals.length ? <p className="text-xs text-muted">Next 12 months if nothing changes. Not what you paid.</p> : null}
        </Kpi>
        <Kpi id="kpi-active" label="Active subscriptions">
          <p className="text-3xl font-semibold text-accent-text tnum">{view.counts.active}</p>
          <p className="text-xs text-muted">
            {view.counts.trial} on trial · {view.counts.paused} paused (not counted in totals)
          </p>
        </Kpi>
        <Kpi id="kpi-week" label="Renewing in 7 days" kind="projection">
          <p className="text-3xl font-semibold text-accent-text tnum">{view.week.length}</p>
          {view.weekAmounts.length ? (
            <p className="text-xs text-muted">
              Due: {view.weekAmounts.map((a, i) => <span key={a.currency}>{i > 0 ? ' + ' : ''}<Money minor={a.amountMinor} currency={a.currency} /></span>)}
            </p>
          ) : (
            <p className="text-xs text-muted">{view.week.length ? 'Only trial endings: no charge yet.' : 'Nothing due this week.'}</p>
          )}
        </Kpi>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3" aria-labelledby="recorded-h">
          <CardHeader id="recorded-h" title="Recorded payments by month" tag={<KindTag kind="recorded" />} />
          {payQ.status === 'error' ? (
            <ErrorState error={payQ.error} onRetry={payQ.retry} title="We couldn’t load your payments" />
          ) : !records ? (
            <LoadingRegion label="Loading recorded payments"><Skeleton className="h-48" /></LoadingRegion>
          ) : records.payments.length === 0 || !recCur ? (
            <EmptyState title="No payments recorded yet" icon="clock">
              This chart shows only payments you record: nothing is estimated or filled in. Open a subscription and choose “Record payment” after you’ve paid.
            </EmptyState>
          ) : (
            <>
              <CurrencyPicker id="recorded-currency" currencies={recCurrencies} value={recCur} onChange={setRecCurrency} />
              <MonthlyBars data={recordedByMonth(records.payments, recCur, today)} currency={recCur} subject="Recorded payments" />
              {records.partial ? (
                <p className="mt-2 text-xs text-warn">Includes your {RECORDED_SUBSCRIPTION_CAP} most recently added subscriptions only.</p>
              ) : null}
            </>
          )}
        </Card>

        <Card className="lg:col-span-2" aria-labelledby="cat-h">
          <CardHeader id="cat-h" title="Spending by category" tag={<KindTag kind="estimate" />} />
          {catCur ? (
            <>
              <CurrencyPicker id="category-currency" currencies={catCurrencies} value={catCur} onChange={setCatCurrency} />
              <CategoryBars shares={categoryBreakdown(subs, catCur)} currency={catCur} />
              <p className="mt-3 text-xs text-muted">Monthly equivalent of active subscriptions in {catCur}.</p>
            </>
          ) : (
            <p className="text-sm text-muted">No active subscriptions to break down.</p>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3" aria-labelledby="upcoming-h">
          <CardHeader
            id="upcoming-h"
            title="Upcoming renewals"
            tag={<KindTag kind="projection" />}
            action={
              <div role="group" aria-label="Renewal window" className="flex gap-1 rounded-control border border-strong bg-canvas p-1">
                {([7, 30, 90] as const).map((d) => (
                  <button key={d} type="button" aria-pressed={windowDays === d} onClick={() => setWindowDays(d)} className={`min-h-8 rounded-[0.55rem] px-3 text-xs font-semibold ${windowDays === d ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg'}`}>
                    {d} days
                  </button>
                ))}
              </div>
            }
          />
          {view.list.length === 0 ? (
            <EmptyState title={`No renewals in the next ${windowDays} days`} icon="clock">
              Paused, cancelled and archived subscriptions don’t renew. Trials appear on the day they end.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {view.list.map((r) => (
                <li key={r.subscription.id}>
                  <Link
                    to={`/subscriptions/${r.subscription.id}`}
                    className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-control py-3 !text-fg no-underline hover:bg-raised sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-2"
                  >
                    <span className="row-span-2 sm:row-span-1">
                      <ServiceIcon subscription={r.subscription} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{r.subscription.name}</span>
                      <span className="block text-xs text-muted">
                        {r.kind === 'trial_end' ? 'Trial ends · then ' : ''}
                        <Money minor={r.subscription.amountMinor} currency={r.subscription.currency} /> / {FREQUENCY_UNIT[r.subscription.billingFrequency]}
                      </span>
                    </span>
                    <span className="col-start-2 text-sm sm:col-start-3 sm:row-start-1 sm:text-right">
                      <DateText date={r.date} today={today} />
                      {r.calculated ? <span className="block text-xs text-muted">calculated from schedule</span> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 text-right">
            <Link to="/subscriptions" className="text-sm">View all subscriptions</Link>
          </div>
        </Card>

        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Card aria-labelledby="recent-pay-h">
            <CardHeader id="recent-pay-h" title="Recent payments" tag={<KindTag kind="recorded" />} />
            {payQ.status === 'error' ? (
              <p className="text-sm text-muted">Payments couldn’t be loaded.</p>
            ) : !records ? (
              <LoadingRegion label="Loading recent payments"><Skeleton className="h-24" /></LoadingRegion>
            ) : records.payments.length === 0 ? (
              <p className="text-sm text-muted">Nothing recorded yet. Only payments you record appear here.</p>
            ) : (
              <ul className="divide-y divide-line">
                {recentPayments(records.payments).map(({ payment, subscriptionId, subscriptionName }) => (
                  <li key={payment.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="min-w-0">
                      <Link to={`/subscriptions/${subscriptionId}`} className="block truncate font-medium !text-fg">{subscriptionName}</Link>
                      <span className="text-xs text-muted">{formatDate(payment.paidOn)} · {PAYMENT_STATUS_LABEL[payment.status]}</span>
                    </span>
                    <Money minor={payment.status === 'refunded' ? -payment.amountMinor : payment.amountMinor} currency={payment.currency} className={payment.status === 'failed' ? 'text-muted line-through' : ''} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card aria-labelledby="recent-sub-h">
            <CardHeader id="recent-sub-h" title="Recently added" />
            <ul className="divide-y divide-line">
              {view.recent.map((s) => (
                <li key={s.id}>
                  <Link to={`/subscriptions/${s.id}`} className="flex items-center gap-3 py-2.5 !text-fg no-underline">
                    <ServiceIcon subscription={s} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{s.name}</span>
                      <span className="text-xs text-muted">Added {formatDate(todayIn(preferences.timezone, new Date(s.createdAt)), { weekday: false })}</span>
                    </span>
                    <span className="text-sm"><Money minor={s.amountMinor} currency={s.currency} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
