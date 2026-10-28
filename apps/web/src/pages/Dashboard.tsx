import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { Category } from '@subcycle/shared';
import { analyticsApi, fetchAllSubscriptions } from '../api/endpoints';
import { BucketBars, CategoryBars, Donut } from '../components/charts';
import { LinkButton } from '../components/ui/Button';
import { Card, CardHeader, DateText, EmptyState, ErrorState, KindTag, LoadingRegion, Money, ServiceIcon, Skeleton } from '../components/ui/display';
import { SelectField } from '../components/ui/Field';
import { Icon, type IconName } from '../components/ui/Icon';
import { activeTotals, categoryBreakdown, renewalAmounts, upcomingRenewals } from '../lib/dashboard';
import { formatDate, formatMonth, formatMonthShort, greetingFor, todayIn } from '../lib/dates';
import { CATEGORY_SLOT, FREQUENCY_UNIT, PAYMENT_STATUS_LABEL } from '../lib/labels';
import { orderCurrencies } from '../lib/money';
import { useApi } from '../state/data';
import { useSession } from '../state/auth';
import { usePageTitle, useToday } from '../state/ui';

function IconBubble({ name }: { name: IconName }) {
  return (
    <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text ring-1 ring-line">
      <Icon name={name} />
    </span>
  );
}

/** A stat tile: icon bubble, label (with its Estimate / Projection tag) and the figures. */
function Kpi({ id, label, kind, icon, children }: { id: string; label: string; kind?: 'estimate' | 'projection'; icon: IconName; children: ReactNode }) {
  return (
    <Card aria-labelledby={id}>
      <div className="flex items-start gap-4">
        <IconBubble name={icon} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={id} className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</h2>
            {kind ? <KindTag kind={kind} /> : null}
          </div>
          <div className="mt-2 space-y-1">{children}</div>
        </div>
      </div>
    </Card>
  );
}

/** One line per currency: the preferred one large, the rest smaller. Currencies are never summed together. */
function CurrencyLines({ rows }: { rows: { currency: string; minor: number }[] }) {
  return (
    <>
      {rows.map((r, i) => (
        <p key={r.currency} className={i === 0 ? 'text-3xl font-bold tracking-tight text-fg sm:text-4xl' : 'text-lg font-semibold text-muted'}>
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
  // Recorded spending and recent payments come from ONE analytics request (not one request per subscription).
  const payQ = useApi((signal) => analyticsApi.spending({}, signal), [today], { enabled: subs !== undefined && subs.length > 0 });

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
  const records = payQ.status === 'ready' ? payQ.data.recorded : undefined;
  const recCurrencies = records ? orderCurrencies(records.currencies.map((c) => c.currency), preferences.currency) : [];
  const recCur = recCurrency && recCurrencies.includes(recCurrency) ? recCurrency : recCurrencies[0];
  const recSeries = records && recCur ? records.currencies.find((c) => c.currency === recCur) : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{greeting}</h1>
          <p className="mt-2 text-sm text-muted">Here’s your subscription picture. Figures labelled Estimate or Projection are calculated, not money you paid.</p>
        </div>
        <LinkButton to="/subscriptions/new" variant="primary" className="hidden sm:inline-flex"><Icon name="plus" className="h-4 w-4" />Add subscription</LinkButton>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]" aria-label="Summary">
        <Card aria-labelledby="kpi-monthly" className="lg:row-span-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="kpi-monthly" className="text-xs font-semibold uppercase tracking-wider text-muted">Monthly equivalent</h2>
            <KindTag kind="estimate" />
          </div>
          {view.totals.length ? (
            <div className="mt-5 flex flex-col items-center gap-6 sm:flex-row">
              <Donut shares={categoryBreakdown(subs, view.totals[0]!.currency).map((s) => ({ slot: CATEGORY_SLOT[s.category as Category], percent: s.percent }))}>
                <span className="text-xs text-muted">{view.totals[0]!.currency}</span>
                <span className="text-sm font-semibold">per month</span>
              </Donut>
              <div className="min-w-0 flex-1 space-y-1 text-center sm:text-left">
                <CurrencyLines rows={view.totals.map((t) => ({ currency: t.currency, minor: t.monthlyEquivalentMinor }))} />
                <p className="pt-2 text-xs text-muted">Active subscriptions at today’s prices, per currency.</p>
                <p className="text-xs text-muted">The ring shows how the first currency’s total splits across categories.</p>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">No active subscriptions.</p>
          )}
        </Card>
        <Kpi id="kpi-annual" label="Annualized cost" kind="projection" icon="chart">
          {view.totals.length ? <CurrencyLines rows={view.totals.map((t) => ({ currency: t.currency, minor: t.annualizedMinor }))} /> : <p className="text-sm text-muted">No active subscriptions.</p>}
          {view.totals.length ? <p className="text-xs text-muted">Next 12 months if nothing changes. Not what you paid.</p> : null}
        </Kpi>
        <Kpi id="kpi-active" label="Active subscriptions" icon="list">
          <p className="text-4xl font-bold text-fg tnum">{view.counts.active}</p>
          <p className="text-xs text-muted">
            {view.counts.trial} on trial · {view.counts.paused} paused (not counted in totals)
          </p>
        </Kpi>
        <Kpi id="kpi-week" label="Renewing in 7 days" kind="projection" icon="calendar">
          <p className="text-4xl font-bold text-fg tnum">{view.week.length}</p>
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
          ) : !recSeries || !recCur ? (
            <EmptyState title="No payments recorded yet" icon="clock">
              This chart shows only payments you record: nothing is estimated or filled in. Open a subscription and choose “Record payment” after you’ve paid.
            </EmptyState>
          ) : (
            <>
              <CurrencyPicker id="recorded-currency" currencies={recCurrencies} value={recCur} onChange={setRecCurrency} />
              <BucketBars
                data={recSeries.buckets.map((b) => ({ key: b.start, label: formatMonth(b.start.slice(0, 7)), short: formatMonthShort(b.start.slice(0, 7)), netMinor: b.netMinor }))}
                currency={recCur}
                subject="Recorded payments"
                unit="month"
              />
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
              <div role="group" aria-label="Renewal window" className="flex gap-1 rounded-full border border-line bg-canvas p-1">
                {([7, 30, 90] as const).map((d) => (
                  <button key={d} type="button" aria-pressed={windowDays === d} onClick={() => setWindowDays(d)} className={`min-h-8 rounded-full px-3 text-xs font-semibold ${windowDays === d ? 'bg-accent-grad text-accent-fg' : 'text-muted hover:text-fg'}`}>
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
            <ul className="space-y-2">
              {view.list.map((r) => (
                <li key={r.subscription.id}>
                  <Link
                    to={`/subscriptions/${r.subscription.id}`}
                    className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-2xl border border-transparent bg-raised/60 px-3 py-3 !text-fg no-underline hover:border-line hover:bg-raised sm:grid-cols-[auto_minmax(0,1fr)_auto]"
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
            ) : records.recentPayments.length === 0 ? (
              <p className="text-sm text-muted">Nothing recorded yet. Only payments you record appear here.</p>
            ) : (
              <ul className="divide-y divide-line">
                {records.recentPayments.map((p) => (
                  <li key={p.paymentId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="min-w-0">
                      <Link to={`/subscriptions/${p.subscriptionId}`} className="block truncate font-medium !text-fg">{p.subscriptionName}</Link>
                      <span className="text-xs text-muted">{formatDate(p.paidOn)} · {PAYMENT_STATUS_LABEL[p.status]}</span>
                    </span>
                    <Money minor={p.status === 'refunded' ? -p.amountMinor : p.amountMinor} currency={p.currency} className={p.status === 'failed' ? 'text-muted line-through' : ''} />
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
