import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { addDays, type AnalyticsBucket, type AnalyticsResponse } from '@subcycle/shared';
import { analyticsApi } from '../api/endpoints';
import { BucketBars, CategoryBars } from '../components/charts';
import { Card, CardHeader, EmptyState, ErrorState, KindTag, LoadingRegion, Money, Skeleton } from '../components/ui/display';
import { SelectField } from '../components/ui/Field';
import { firstOfMonth, monthOf, shiftMonth } from '../lib/calendarGrid';
import { formatDate, formatMonth, formatMonthShort } from '../lib/dates';
import { orderCurrencies } from '../lib/money';
import { useApi } from '../state/data';
import { useSession } from '../state/auth';
import { usePageTitle, useToday } from '../state/ui';

const PERIODS: Record<AnalyticsBucket, { value: string; label: string }[]> = {
  month: [{ value: '3', label: 'Last 3 months' }, { value: '6', label: 'Last 6 months' }, { value: '12', label: 'Last 12 months' }, { value: '24', label: 'Last 24 months' }],
  week: [{ value: '8', label: 'Last 8 weeks' }, { value: '13', label: 'Last 13 weeks' }, { value: '26', label: 'Last 26 weeks' }, { value: '52', label: 'Last 52 weeks' }],
};

function currenciesIn(a: AnalyticsResponse): string[] {
  return [
    ...a.estimate.currencies.map((c) => c.currency),
    ...a.recorded.currencies.map((c) => c.currency),
    ...a.projection.windows.flatMap((w) => w.currencies.map((c) => c.currency)),
  ];
}

export function AnalyticsPage() {
  usePageTitle('Analytics');
  const today = useToday();
  const { preferences } = useSession();
  const [bucket, setBucket] = useState<AnalyticsBucket>('month');
  const [count, setCount] = useState('12');
  const [currency, setCurrency] = useState<string | null>(null);

  const n = Number(count);
  const range = useMemo(
    () => (bucket === 'month' ? { from: firstOfMonth(shiftMonth(monthOf(today), -(n - 1))), to: today } : { from: addDays(today, -(n * 7 - 1)), to: today }),
    [bucket, n, today],
  );
  const q = useApi((signal) => analyticsApi.spending({ ...range, bucket }, signal), [range.from, range.to, bucket]);

  const controls = (
    <div className="grid gap-4 sm:grid-cols-3">
      <SelectField name="bucket" label="Group recorded payments by" value={bucket} onChange={(e) => { const b = e.target.value as AnalyticsBucket; setBucket(b); setCount(b === 'month' ? '12' : '13'); }} options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week (starting Monday)' }]} />
      <SelectField name="period" label="Period" value={count} onChange={(e) => setCount(e.target.value)} options={PERIODS[bucket]} />
      {q.status === 'ready' ? (
        (() => {
          const all = orderCurrencies(currenciesIn(q.data), preferences.currency);
          return all.length > 1 ? (
            <SelectField name="currency" label="Currency" value={currency && all.includes(currency) ? currency : all[0]!} onChange={(e) => setCurrency(e.target.value)} options={all.map((c) => ({ value: c, label: c }))} hint="Amounts in different currencies are never added together." />
          ) : null;
        })()
      ) : null}
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl">Analytics</h1>
        <p className="mt-1 text-sm text-muted">Three different things, kept apart: what you <strong>recorded</strong> paying, a calculated <strong>estimate</strong> of your recurring cost, and a <strong>projection</strong> of what’s coming.</p>
      </div>
      <Card aria-labelledby="controls-h">
        <h2 id="controls-h" className="sr-only">Options</h2>
        {controls}
      </Card>

      {q.status === 'error' ? (
        <ErrorState error={q.error} onRetry={q.retry} title="We couldn’t load your analytics" level={2} />
      ) : q.status !== 'ready' ? (
        <LoadingRegion label="Loading analytics">
          <Skeleton className="h-64" />
          <Skeleton className="mt-6 h-64" />
        </LoadingRegion>
      ) : (
        <Sections data={q.data} bucket={bucket} currency={currency} />
      )}
    </div>
  );
}

function Sections({ data, bucket, currency: chosen }: { data: AnalyticsResponse; bucket: AnalyticsBucket; currency: string | null }) {
  const { preferences } = useSession();
  const all = orderCurrencies(currenciesIn(data), preferences.currency);
  const currency = chosen && all.includes(chosen) ? chosen : all[0];

  if (!currency) {
    return (
      <EmptyState title="Nothing to analyse yet" icon="info" level={2} action={<Link to="/subscriptions/new">Add a subscription</Link>}>
        Add a subscription to see estimates and projections, and record payments to see what you’ve actually paid.
      </EmptyState>
    );
  }

  const recorded = data.recorded.currencies.find((c) => c.currency === currency);
  const estimate = data.estimate.currencies.find((c) => c.currency === currency);

  return (
    <>
      <Card aria-labelledby="rec-h">
        <CardHeader id="rec-h" title="Recorded spending" tag={<KindTag kind="recorded" />} />
        <p className="mb-4 text-xs text-muted">
          Payments you recorded dated {formatDate(data.recorded.from)} to {formatDate(data.recorded.to)} (your local calendar dates, both included),
          paid minus refunded, in {currency}. SubCycle doesn’t check them against your bank or the providers.
        </p>
        {!recorded ? (
          <EmptyState title={`No ${currency} payments recorded in this period`} icon="clock">
            This chart only shows payments you record: nothing is estimated or filled in from your schedules.
          </EmptyState>
        ) : (
          <>
            <dl className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Net spent" minor={recorded.netMinor} currency={currency} strong />
              <Stat label="Paid" minor={recorded.paidMinor} currency={currency} />
              <Stat label="Refunded" minor={recorded.refundedMinor} currency={currency} />
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wider text-muted">Payments</dt>
                <dd className="mt-1 text-sm tnum">{recorded.paymentCount}{recorded.failedCount ? ` (+${recorded.failedCount} failed, not counted)` : ''}</dd>
              </div>
            </dl>
            <BucketBars
              data={recorded.buckets.map((b) => ({
                key: b.start,
                label: bucket === 'month' ? formatMonth(b.start.slice(0, 7)) : formatDate(b.start, { weekday: false }),
                short: bucket === 'month' ? formatMonthShort(b.start.slice(0, 7)) : formatDate(b.start, { weekday: false, year: false }),
                netMinor: b.netMinor,
              }))}
              currency={currency}
              subject="Recorded spending"
              unit={bucket}
            />
          </>
        )}
      </Card>

      <Card aria-labelledby="est-h">
        <CardHeader id="est-h" title="Recurring cost" tag={<KindTag kind="estimate" />} />
        {!estimate ? (
          <p className="text-sm text-muted">No active {currency} subscriptions. Trials, paused, cancelled and archived ones aren’t counted.</p>
        ) : (
          <>
            <dl className="mb-5 grid grid-cols-2 gap-4">
              <Stat label="Monthly equivalent" minor={estimate.monthlyEquivalentMinor} currency={currency} strong />
              <Stat label="Per year (if nothing changes)" minor={estimate.annualizedMinor} currency={currency} />
            </dl>
            <p className="mb-4 text-xs text-muted">
              Calculated from the current price of your {estimate.subscriptionCount} active {estimate.subscriptionCount === 1 ? 'subscription' : 'subscriptions'} in {currency}. It is not what you paid.
            </p>
            <h3 className="mb-2 text-sm font-semibold">By category</h3>
            <CategoryBars shares={estimate.byCategory.map((c) => ({ category: c.category, monthlyEquivalentMinor: c.monthlyEquivalentMinor, percent: c.percent }))} currency={currency} />
            <h3 className="mb-2 mt-6 text-sm font-semibold">Most expensive</h3>
            <ol className="divide-y divide-line">
              {estimate.top.map((t) => (
                <li key={t.subscriptionId} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <Link to={`/subscriptions/${t.subscriptionId}`} className="min-w-0 truncate font-medium !text-fg">{t.name}</Link>
                  <span className="shrink-0 text-right"><Money minor={t.monthlyEquivalentMinor} currency={currency} /> <span className="text-xs text-muted">/ month</span></span>
                </li>
              ))}
            </ol>
          </>
        )}
      </Card>

      <Card aria-labelledby="proj-h">
        <CardHeader id="proj-h" title="Coming up" tag={<KindTag kind="projection" />} />
        <p className="mb-3 text-xs text-muted">Expected renewals at today’s prices, counting every renewal in the window (a weekly subscription counts each week). Not confirmed charges.</p>
        <table className="w-full text-sm">
          <caption className="sr-only">Expected renewals in {currency} for the next 7, 30 and 90 days</caption>
          <thead>
            <tr className="text-left text-muted">
              <th scope="col" className="py-1 font-medium">Next</th>
              <th scope="col" className="py-1 text-right font-medium">Renewals</th>
              <th scope="col" className="py-1 text-right font-medium">Expected ({currency})</th>
              <th scope="col" className="py-1 text-right font-medium">Trials ending</th>
            </tr>
          </thead>
          <tbody>
            {data.projection.windows.map((w) => {
              const row = w.currencies.find((c) => c.currency === currency);
              return (
                <tr key={w.days} className="border-t border-line">
                  <th scope="row" className="py-2 text-left font-normal">{w.days} days <span className="text-xs text-muted">(to {formatDate(w.to, { weekday: false })})</span></th>
                  <td className="py-2 text-right tnum">{row?.renewalCount ?? 0}</td>
                  <td className="py-2 text-right"><Money minor={row?.amountMinor ?? 0} currency={currency} /></td>
                  <td className="py-2 text-right tnum">{w.trialEndCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">The trials-ending count covers all currencies: a trial has no charge until it converts.</p>
      </Card>
    </>
  );
}

function Stat({ label, minor, currency, strong = false }: { label: string; minor: number; currency: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</dt>
      <dd className={`mt-1 ${strong ? 'text-2xl font-semibold text-accent-text' : 'text-base font-semibold'}`}><Money minor={minor} currency={currency} className="!whitespace-normal break-words" /></dd>
    </div>
  );
}
