import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { DateOnly, PaymentDto, SubscriptionDto } from '@subcycle/shared';
import { paymentsApi, priceHistoryApi, subscriptionsApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { PaymentDialog } from '../components/PaymentDialog';
import { StatusActions } from '../components/StatusActions';
import { Button, LinkButton } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/Dialog';
import { Card, CardHeader, DateText, EmptyState, ErrorState, KindTag, LoadingRegion, Money, Pagination, ServiceIcon, Skeleton, StatusBadge } from '../components/ui/display';
import { Icon } from '../components/ui/Icon';
import { formatDate } from '../lib/dates';
import { CATEGORY_LABEL, FREQUENCY_LABEL, FREQUENCY_UNIT, PAYMENT_STATUS_LABEL, USAGE_LABEL } from '../lib/labels';
import { moneyText } from '../lib/money';
import { useApi, useInvalidate } from '../state/data';
import { usePageTitle, useToast, useToday } from '../state/ui';

const PAGE = 10;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

function NextRenewal({ s, today }: { s: SubscriptionDto; today: DateOnly }) {
  if (s.status === 'active' && s.effectiveNextBillingDate) {
    const calculated = s.effectiveNextBillingDate !== s.nextBillingDate;
    return (
      <>
        <span className="mr-2"><DateText date={s.effectiveNextBillingDate} today={today} /></span>
        <KindTag kind="projection" />
        {calculated ? (
          <p className="mt-1 text-xs text-muted">Calculated from your billing schedule. The saved date ({formatDate(s.nextBillingDate)}) hasn’t been updated yet.</p>
        ) : null}
      </>
    );
  }
  if (s.status === 'trial') {
    const end = s.trialEndDate ?? s.nextBillingDate;
    return (
      <>
        <span>Trial ends <DateText date={end} today={today} /></span>
        {end < today ? (
          <p className="mt-1 text-xs text-warn">The trial date has passed. Convert it to a paid subscription or record a cancellation: SubCycle doesn’t convert trials automatically.</p>
        ) : null}
      </>
    );
  }
  const message: Record<string, string> = {
    paused: 'Paused: not counted in your totals or upcoming renewals.',
    cancelled: s.cancelledOn ? `You recorded this cancellation on ${formatDate(s.cancelledOn)}. SubCycle can’t confirm it with the provider.` : 'Cancelled.',
    archived: 'Archived: hidden from lists by default.',
  };
  return <span className="text-muted">{message[s.status]}</span>;
}

export function SubscriptionDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const today = useToday();
  const toast = useToast();
  const invalidate = useInvalidate();

  const subQ = useApi((signal) => subscriptionsApi.get(id, signal), [id]);
  const sub = subQ.status === 'ready' ? subQ.data : undefined;
  usePageTitle(sub?.name ?? 'Subscription');

  const [payPage, setPayPage] = useState(1);
  const [histPage, setHistPage] = useState(1);
  const payQ = useApi((signal) => paymentsApi.list(id, { page: payPage, pageSize: PAGE }, signal), [id, payPage], { enabled: sub !== undefined });
  const histQ = useApi((signal) => priceHistoryApi.list(id, { page: histPage, pageSize: PAGE }, signal), [id, histPage], { enabled: sub !== undefined });
  const projects = sub !== undefined && (sub.status === 'active' || sub.status === 'trial');
  const upQ = useApi((signal) => subscriptionsApi.upcoming(id, 3, signal), [id], { enabled: projects });

  const [recording, setRecording] = useState(false);
  const [deletingPayment, setDeletingPayment] = useState<PaymentDto | null>(null);
  const [deletingSub, setDeletingSub] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // After deleting the last row on a later page, step back instead of showing an empty page.
  useEffect(() => {
    if (payQ.status === 'ready' && payQ.data.items.length === 0 && payQ.data.meta.total > 0 && payPage > 1) setPayPage((p) => p - 1);
  }, [payQ, payPage]);

  if (subQ.status === 'error') {
    return subQ.error.status === 404 ? (
      <EmptyState title="Subscription not found" icon="search" level={1} action={<LinkButton to="/subscriptions">Back to subscriptions</LinkButton>}>
        It may have been deleted, or the link is wrong.
      </EmptyState>
    ) : (
      <ErrorState error={subQ.error} onRetry={subQ.retry} title="We couldn’t load this subscription" level={1} />
    );
  }
  if (!sub) {
    return (
      <LoadingRegion label="Loading subscription">
        <Skeleton className="h-24" />
        <Skeleton className="mt-4 h-48" />
        <Skeleton className="mt-4 h-48" />
      </LoadingRegion>
    );
  }

  const link = sub.cancellationUrl ?? sub.websiteUrl;

  async function removePayment() {
    if (!deletingPayment) return;
    setBusy(true);
    setDialogError(null);
    try {
      await paymentsApi.remove(sub!.id, deletingPayment.id);
      invalidate();
      toast({ kind: 'success', message: 'Payment record removed. Your billing date was not changed.' });
      setDeletingPayment(null);
    } catch (err) {
      setDialogError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function removeSubscription() {
    setBusy(true);
    setDialogError(null);
    try {
      await subscriptionsApi.remove(sub!.id);
      invalidate();
      toast({ kind: 'success', message: `Deleted ${sub!.name}.` });
      navigate('/subscriptions', { replace: true });
    } catch (err) {
      setDialogError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  const paymentTotal = payQ.status === 'ready' ? payQ.data.meta.total : null;

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link to="/subscriptions" className="inline-flex items-center gap-1 text-muted no-underline hover:text-fg">
          <Icon name="chevron-left" className="h-4 w-4" />
          All subscriptions
        </Link>
      </nav>

      <Card aria-labelledby="sub-title">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <ServiceIcon subscription={sub} size="lg" />
            <div className="min-w-0">
              <h1 id="sub-title" className="truncate text-2xl">{sub.name}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                <StatusBadge status={sub.status} />
                <span>{CATEGORY_LABEL[sub.category]}</span>
              </div>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold text-accent-text">
              <Money minor={sub.amountMinor} currency={sub.currency} />
            </p>
            <p className="text-sm text-muted">per {FREQUENCY_UNIT[sub.billingFrequency]} ({FREQUENCY_LABEL[sub.billingFrequency].toLowerCase()})</p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <LinkButton to={`/subscriptions/${sub.id}/edit`} size="sm"><Icon name="edit" className="h-4 w-4" />Edit</LinkButton>
          <StatusActions s={sub} today={today} />
        </div>
      </Card>

      <Card aria-labelledby="facts-h">
        <h2 id="facts-h" className="-mx-4 mb-4 border-b border-line px-4 pb-3 text-lg sm:-mx-6 sm:px-6">Billing</h2>
        <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
          <Fact label="Next renewal"><NextRenewal s={sub} today={today} /></Fact>
          <Fact label="Monthly equivalent">
            <span className="mr-2"><Money minor={sub.monthlyEquivalentMinor} currency={sub.currency} /></span>
            <KindTag kind="estimate" />
            <p className="mt-1 text-xs text-muted">Calculated from the current price. It is not money you paid.</p>
          </Fact>
          <Fact label="Billing day comes from">
            <DateText date={sub.anchorDate} today={today} relative={false} />
          </Fact>
          <Fact label="Started"><DateText date={sub.startDate} today={today} relative={false} /></Fact>
          {sub.trialEndDate ? <Fact label="Trial end"><DateText date={sub.trialEndDate} today={today} /></Fact> : null}
          {sub.paymentMethodLabel ? <Fact label="Payment method">{sub.paymentMethodLabel}</Fact> : null}
          {sub.usageLevel ? <Fact label="How often you use it">{USAGE_LABEL[sub.usageLevel]}</Fact> : null}
          {link ? (
            <Fact label={sub.cancellationUrl ? 'Cancellation page' : 'Website'}>
              <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 break-all">
                {link.replace(/^https?:\/\//, '')}
                <Icon name="external" className="h-4 w-4" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              {sub.cancellationUrl ? <p className="mt-1 text-xs text-muted">Cancelling happens on their site. Come back and record it once it’s done.</p> : null}
            </Fact>
          ) : null}
          {sub.notes ? <Fact label="Notes"><span className="whitespace-pre-wrap">{sub.notes}</span></Fact> : null}
        </dl>
      </Card>

      {projects ? (
        <Card aria-labelledby="upcoming-h">
          <CardHeader id="upcoming-h" title="Projected renewals" tag={<KindTag kind="projection" />} />
          {upQ.status === 'error' ? (
            <ErrorState error={upQ.error} onRetry={upQ.retry} title="We couldn’t load projected renewals" />
          ) : upQ.status !== 'ready' ? (
            <LoadingRegion label="Loading projected renewals"><Skeleton className="h-16" /></LoadingRegion>
          ) : upQ.data.length === 0 ? (
            <p className="text-sm text-muted">No renewals are projected: the trial date has passed. Convert it or record a cancellation.</p>
          ) : (
            <>
              <ul className="divide-y divide-line">
                {upQ.data.map((o) => (
                  <li key={o.date} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <DateText date={o.date} today={today} />
                    <Money minor={o.amountMinor} currency={o.currency} />
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">Projected from today’s price and schedule. Not a record of charges.</p>
            </>
          )}
        </Card>
      ) : null}

      <Card aria-labelledby="payments-h">
        <CardHeader
          id="payments-h"
          title="Recorded payments"
          tag={<KindTag kind="recorded" />}
          action={<Button size="sm" variant="primary" onClick={() => setRecording(true)}><Icon name="plus" className="h-4 w-4" />Record payment</Button>}
        />
        <p className="mb-4 text-xs text-muted">You record these yourself. SubCycle doesn’t check them against your bank or {sub.name}.</p>
        {payQ.status === 'error' ? (
          <ErrorState error={payQ.error} onRetry={payQ.retry} title="We couldn’t load payments" />
        ) : payQ.status !== 'ready' ? (
          <LoadingRegion label="Loading payments"><Skeleton className="h-24" /></LoadingRegion>
        ) : payQ.data.meta.total === 0 ? (
          <EmptyState title="No payments recorded" icon="clock">Nothing has been recorded for this subscription. Use “Record payment” after you’ve paid.</EmptyState>
        ) : (
          <>
            <ul className="divide-y divide-line" aria-busy={payQ.refreshing || undefined}>
              {payQ.data.items.map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      <span className="tnum">{formatDate(p.paidOn)}</span> <span className="font-normal text-muted">· {PAYMENT_STATUS_LABEL[p.status]}</span>
                    </p>
                    {p.forBillingDate ? <p className="text-xs text-muted">For the renewal on {formatDate(p.forBillingDate)}</p> : null}
                    {p.note ? <p className="mt-0.5 break-words text-xs text-muted">{p.note}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Money minor={p.status === 'refunded' ? -p.amountMinor : p.amountMinor} currency={p.currency} className={p.status === 'failed' ? 'text-muted line-through' : 'font-semibold'} />
                    <button
                      type="button"
                      onClick={() => { setDialogError(null); setDeletingPayment(p); }}
                      className="rounded-control p-2 text-muted hover:bg-raised hover:text-danger"
                      aria-label={`Delete payment of ${moneyText(p.amountMinor, p.currency)} on ${formatDate(p.paidOn)}`}
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <Pagination page={payQ.data.meta.page} pageSize={payQ.data.meta.pageSize} total={payQ.data.meta.total} onPage={setPayPage} label="Payments pagination" />
          </>
        )}
      </Card>

      <Card aria-labelledby="history-h">
        <CardHeader id="history-h" title="Price history" />
        {histQ.status === 'error' ? (
          <ErrorState error={histQ.error} onRetry={histQ.retry} title="We couldn’t load price history" />
        ) : histQ.status !== 'ready' ? (
          <LoadingRegion label="Loading price history"><Skeleton className="h-16" /></LoadingRegion>
        ) : histQ.data.meta.total === 0 ? (
          <p className="text-sm text-muted">No price changes recorded. When you edit the price, you can record the change here.</p>
        ) : (
          <>
            <ul className="divide-y divide-line">
              {histQ.data.items.map((h) => (
                <li key={h.id} className="py-3 text-sm">
                  <p className="flex flex-wrap items-center gap-x-2 font-medium">
                    <Money minor={h.oldAmountMinor} currency={h.currency} className="text-muted" />
                    <Icon name="chevron-right" className="h-4 w-4 text-muted" />
                    <span className="sr-only">changed to</span>
                    <Money minor={h.newAmountMinor} currency={h.currency} />
                  </p>
                  <p className="text-xs text-muted">Effective {formatDate(h.effectiveOn)}{h.note ? ` · ${h.note}` : ''}</p>
                </li>
              ))}
            </ul>
            <Pagination page={histQ.data.meta.page} pageSize={histQ.data.meta.pageSize} total={histQ.data.meta.total} onPage={setHistPage} label="Price history pagination" />
          </>
        )}
      </Card>

      <Card aria-labelledby="danger-h" className="border-danger/40">
        <h2 id="danger-h" className="text-base">Delete permanently</h2>
        <p className="mt-1 text-sm text-muted">
          Removes this subscription{paymentTotal ? `, its ${paymentTotal} recorded ${paymentTotal === 1 ? 'payment' : 'payments'}` : ''} and its price history. This can’t be undone. To keep the history, archive it instead.
        </p>
        <Button className="mt-4" variant="danger" size="sm" onClick={() => { setDialogError(null); setDeletingSub(true); }}>
          <Icon name="trash" className="h-4 w-4" />
          Delete {sub.name}
        </Button>
      </Card>

      {recording ? <PaymentDialog s={sub} today={today} onClose={() => setRecording(false)} /> : null}

      <ConfirmDialog
        open={deletingPayment !== null}
        onClose={() => setDeletingPayment(null)}
        title="Delete this payment record?"
        description={deletingPayment ? `This removes the record of ${moneyText(deletingPayment.amountMinor, deletingPayment.currency)} on ${formatDate(deletingPayment.paidOn)}. It doesn’t change your next billing date.` : ''}
        confirmLabel="Delete payment"
        danger
        busy={busy}
        error={dialogError}
        onConfirm={removePayment}
      />
      <ConfirmDialog
        open={deletingSub}
        onClose={() => setDeletingSub(false)}
        title={`Delete ${sub.name}?`}
        description="This permanently removes the subscription, its recorded payments and its price history. You can’t undo it."
        confirmLabel="Delete permanently"
        danger
        busy={busy}
        error={dialogError}
        onConfirm={removeSubscription}
      />
    </div>
  );
}
