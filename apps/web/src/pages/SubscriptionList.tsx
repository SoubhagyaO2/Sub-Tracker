import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CATEGORIES, CURRENCY_CODES, FREQUENCIES, type CurrencyCode, type SubscriptionDto } from '@subcycle/shared';
import { subscriptionsApi, type SubscriptionListParams } from '../api/endpoints';
import { Button, LinkButton } from '../components/ui/Button';
import { Card, DateText, EmptyState, ErrorState, LoadingRegion, Money, Pagination, ServiceIcon, Skeleton, StatusBadge } from '../components/ui/display';
import { SelectField, TextField } from '../components/ui/Field';
import { Icon } from '../components/ui/Icon';
import { formatDate } from '../lib/dates';
import { CATEGORY_LABEL, FREQUENCY_LABEL, FREQUENCY_UNIT } from '../lib/labels';
import { parseMoneyInput } from '../lib/money';
import { useApi } from '../state/data';
import { useSession } from '../state/auth';
import { usePageTitle, useToday } from '../state/ui';

const PAGE_SIZE = 25;
const NON_ARCHIVED = ['active', 'trial', 'paused', 'cancelled'];

const STATUS_OPTIONS = [
  { value: '', label: 'All except archived' },
  { value: 'active', label: 'Active' },
  { value: 'trial', label: 'Trial' },
  { value: 'paused', label: 'Paused' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'archived', label: 'Archived' },
];
const SORT_OPTIONS = [
  { value: '', label: 'Recently added' },
  { value: 'nextRenewal', label: 'Next renewal' },
  { value: 'name', label: 'Name' },
  { value: 'price', label: 'Price (monthly equivalent)' },
];
const RENEWS_OPTIONS = [
  { value: '', label: 'Any time' },
  { value: '7', label: 'Within 7 days' },
  { value: '30', label: 'Within 30 days' },
  { value: '90', label: 'Within 90 days' },
];
const DEFAULT_ORDER = { created: 'desc', nextRenewal: 'asc', name: 'asc', price: 'desc' } as const;

type SortKey = keyof typeof DEFAULT_ORDER;

/** Turns the URL into API parameters, plus any problems with what was typed (shown next to the field). */
export function paramsFromUrl(sp: URLSearchParams): { api: SubscriptionListParams; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const get = (k: string) => sp.get(k) ?? '';
  const page = Number(get('page'));
  const api: SubscriptionListParams = { page: Number.isInteger(page) && page >= 1 ? page : 1, pageSize: PAGE_SIZE };

  if (get('q').trim()) api.q = get('q').trim();
  api.status = get('status') ? [get('status')] : NON_ARCHIVED;
  if (get('category')) api.category = [get('category')];
  if (get('frequency')) api.frequency = [get('frequency')];
  if (get('currency')) api.currency = get('currency');
  if (get('renews')) api.renewsWithinDays = Number(get('renews'));
  const sort = (get('sort') || 'created') as SortKey;
  if (sort in DEFAULT_ORDER) api.sort = sort;
  api.order = get('order') === 'asc' || get('order') === 'desc' ? (get('order') as 'asc' | 'desc') : DEFAULT_ORDER[sort in DEFAULT_ORDER ? sort : 'created'];

  // The price range is in the chosen currency's major units and compares the MONTHLY EQUIVALENT.
  for (const [param, key] of [['min', 'minPrice'], ['max', 'maxPrice']] as const) {
    const raw = get(param).trim();
    if (!raw) continue;
    if (!api.currency) {
      errors[param] = 'Choose a currency to filter by price.';
      continue;
    }
    if (/^0+(\.0*)?$/.test(raw)) {
      if (key === 'maxPrice') api.maxPrice = 0;
      continue;
    }
    const parsed = parseMoneyInput(raw, api.currency as CurrencyCode);
    if (parsed.ok) api[key] = parsed.minor;
    else errors[param] = parsed.message;
  }
  if (api.minPrice !== undefined && api.maxPrice !== undefined && api.minPrice > api.maxPrice) errors.min = 'Minimum must not exceed maximum.';
  if (Object.keys(errors).length) {
    delete api.minPrice;
    delete api.maxPrice;
  }
  return { api, errors };
}

function RenewalCell({ s, today }: { s: SubscriptionDto; today: string }) {
  if (s.status === 'active' && s.effectiveNextBillingDate) return <span className="text-sm"><span className="text-muted">Next: </span><DateText date={s.effectiveNextBillingDate} today={today} /></span>;
  if (s.status === 'trial') return <span className="text-sm"><span className="text-muted">Trial ends: </span><DateText date={s.trialEndDate ?? s.nextBillingDate} today={today} /></span>;
  if (s.status === 'cancelled' && s.cancelledOn) return <span className="text-sm text-muted">Cancelled {formatDate(s.cancelledOn)}</span>;
  return null;
}

export function SubscriptionRow({ s, today }: { s: SubscriptionDto; today: string }) {
  // One grid, placed differently per breakpoint, so each piece of content exists exactly once in the DOM:
  // phone: icon | name + price, with the renewal on its own line; desktop: icon | name | renewal | price.
  return (
    <li>
      <Link
        to={`/subscriptions/${s.id}`}
        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-card border border-line bg-surface p-3 !text-fg no-underline hover:border-strong sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:p-4"
      >
        <span className="row-span-2 sm:row-span-1">
          <ServiceIcon subscription={s} />
        </span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium">{s.name}</span>
            {s.status !== 'active' ? <StatusBadge status={s.status} /> : null}
          </span>
          <span className="block text-xs text-muted">{CATEGORY_LABEL[s.category]}</span>
        </span>
        <span className="col-start-2 col-end-4 row-start-2 sm:col-end-auto sm:col-start-3 sm:row-start-1 sm:text-right">
          <RenewalCell s={s} today={today} />
        </span>
        <span className="col-start-3 row-start-1 shrink-0 text-right sm:col-start-4">
          <span className="block text-sm font-semibold">
            <Money minor={s.amountMinor} currency={s.currency} /> <span className="font-normal text-muted">/ {FREQUENCY_UNIT[s.billingFrequency]}</span>
          </span>
          {s.billingFrequency !== 'monthly' ? (
            <span className="block text-xs text-muted">
              ≈ <Money minor={s.monthlyEquivalentMinor} currency={s.currency} /> / month <span className="sr-only">(estimate)</span>
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

export function SubscriptionListPage() {
  usePageTitle('Subscriptions');
  const today = useToday();
  const { preferences } = useSession();
  const [sp, setSp] = useSearchParams();
  const { api, errors } = useMemo(() => paramsFromUrl(sp), [sp]);

  const update = (patch: Record<string, string | undefined>, opts: { replace?: boolean } = {}) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    setSp(next, { replace: opts.replace });
  };

  // Typed fields are debounced into the URL so each keystroke doesn't trigger a request.
  const [search, setSearch] = useState(sp.get('q') ?? '');
  const [min, setMin] = useState(sp.get('min') ?? '');
  const [max, setMax] = useState(sp.get('max') ?? '');
  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((sp.get('q') ?? '') !== search.trim() || (sp.get('min') ?? '') !== min.trim() || (sp.get('max') ?? '') !== max.trim()) {
        update({ q: search.trim(), min: min.trim(), max: max.trim() }, { replace: true });
      }
    }, 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, min, max]);

  const [showFilters, setShowFilters] = useState(false);
  const q = useApi((signal) => subscriptionsApi.list(api, signal), [JSON.stringify(api)]);

  const activeFilters = ['q', 'status', 'category', 'frequency', 'currency', 'min', 'max', 'renews'].filter((k) => (sp.get(k) ?? '') !== '').length;
  const sortKey = (sp.get('sort') || 'created') as SortKey;
  const priceSortNeedsCurrency = sortKey === 'price' && !sp.get('currency');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl">Subscriptions</h1>
        <LinkButton to="/subscriptions/new" variant="primary"><Icon name="plus" className="h-4 w-4" />Add subscription</LinkButton>
      </div>

      <Card aria-labelledby="filters-h" className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="filters-h" className="text-base">Search and filter</h2>
          <Button size="sm" className="md:hidden" aria-expanded={showFilters} aria-controls="filter-panel" onClick={() => setShowFilters((v) => !v)}>
            <Icon name="filter" className="h-4 w-4" />
            Filters{activeFilters ? ` (${activeFilters})` : ''}
          </Button>
        </div>
        <TextField name="search" label="Search by name" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Netflix, Spotify…" autoComplete="off" />
        <div id="filter-panel" className={`${showFilters ? 'block' : 'hidden'} space-y-4 md:block`}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SelectField name="status" label="Status" value={sp.get('status') ?? ''} onChange={(e) => update({ status: e.target.value })} options={STATUS_OPTIONS} />
            <SelectField name="category" label="Category" value={sp.get('category') ?? ''} onChange={(e) => update({ category: e.target.value })} options={[{ value: '', label: 'All categories' }, ...CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))]} />
            <SelectField name="frequency" label="Billing frequency" value={sp.get('frequency') ?? ''} onChange={(e) => update({ frequency: e.target.value })} options={[{ value: '', label: 'Any frequency' }, ...FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }))]} />
            <SelectField name="currency" label="Currency" value={sp.get('currency') ?? ''} onChange={(e) => update({ currency: e.target.value })} options={[{ value: '', label: 'All currencies' }, ...CURRENCY_CODES.map((c) => ({ value: c, label: c === preferences.currency ? `${c} (preferred)` : c }))]} />
            <SelectField name="renews" label="Upcoming renewal" value={sp.get('renews') ?? ''} onChange={(e) => update({ renews: e.target.value })} options={RENEWS_OPTIONS} hint="Active and trial subscriptions, by saved billing date." />
            <div className="grid grid-cols-2 gap-3">
              <TextField name="min" label="Min monthly price" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} error={errors.min} disabled={!sp.get('currency')} />
              <TextField name="max" label="Max monthly price" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} error={errors.max} disabled={!sp.get('currency')} />
              <p className="col-span-2 -mt-2 text-xs text-muted">Compared as a monthly equivalent (an estimate). Pick a currency first: amounts in different currencies are never converted.</p>
            </div>
          </div>
          <div className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SelectField name="sort" label="Sort by" value={sp.get('sort') ?? ''} onChange={(e) => update({ sort: e.target.value, order: undefined })} options={SORT_OPTIONS} hint={priceSortNeedsCurrency ? 'Prices in different currencies aren’t converted. Choose a currency to compare like with like.' : undefined} />
            <SelectField name="order" label="Order" value={api.order ?? ''} onChange={(e) => update({ order: e.target.value })} options={[{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }]} />
            {activeFilters > 0 ? (
              <Button onClick={() => { setSearch(''); setMin(''); setMax(''); setSp(new URLSearchParams(sp.get('sort') ? { sort: sp.get('sort')! } : {})); }}>
                Clear filters
              </Button>
            ) : null}
          </div>
        </div>
      </Card>

      {q.status === 'error' ? (
        <ErrorState error={q.error} onRetry={q.retry} title="We couldn’t load your subscriptions" />
      ) : q.status !== 'ready' ? (
        <LoadingRegion label="Loading subscriptions">
          <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[4.5rem]" />)}</div>
        </LoadingRegion>
      ) : q.data.meta.total === 0 ? (
        activeFilters > 0 ? (
          <EmptyState title="No subscriptions match these filters" icon="search">
            Try a different search, or clear the filters to see everything.
          </EmptyState>
        ) : (
          <EmptyState title="No subscriptions yet" icon="plus" action={<LinkButton to="/subscriptions/new" variant="primary"><Icon name="plus" className="h-4 w-4" />Add subscription</LinkButton>}>
            Add what you pay for and SubCycle will show what’s coming up. Archived subscriptions are hidden unless you filter for them.
          </EmptyState>
        )
      ) : (
        <div aria-busy={q.refreshing || undefined}>
          <p className="mb-3 text-sm text-muted" aria-live="polite">{q.data.meta.total} {q.data.meta.total === 1 ? 'subscription' : 'subscriptions'}</p>
          <ul className={`space-y-3 transition-opacity ${q.refreshing ? 'opacity-60' : ''}`}>
            {q.data.items.map((s) => <SubscriptionRow key={s.id} s={s} today={today} />)}
          </ul>
          <Pagination page={q.data.meta.page} pageSize={q.data.meta.pageSize} total={q.data.meta.total} onPage={(p) => update({ page: String(p) })} label="Subscriptions pagination" />
        </div>
      )}
    </div>
  );
}
