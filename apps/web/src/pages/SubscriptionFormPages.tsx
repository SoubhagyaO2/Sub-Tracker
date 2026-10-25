import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CATEGORIES, CURRENCY_CODES, FREQUENCIES, USAGE_LEVELS, isSupportedCurrency, type CurrencyCode, type SubscriptionDto } from '@subcycle/shared';
import { subscriptionsApi } from '../api/endpoints';
import { ApiError } from '../api/client';
import { Button } from '../components/ui/Button';
import { Card, ErrorState, LoadingRegion, Skeleton, EmptyState } from '../components/ui/display';
import { CheckboxField, DateField, ErrorSummary, MoneyField, SegmentedField, SelectField, TextArea, TextField, focusFirstError } from '../components/ui/Field';
import { CATEGORY_LABEL, FREQUENCY_LABEL, USAGE_LABEL } from '../lib/labels';
import { mapApiError, type FieldErrors } from '../lib/forms';
import {
  buildCreatePayload,
  buildUpdatePayload,
  emptyValues,
  valuesFromSubscription,
  type SubscriptionFormValues,
} from '../lib/subscriptionForm';
import { formatDate } from '../lib/dates';
import { useApi, useInvalidate } from '../state/data';
import { useSession } from '../state/auth';
import { usePageTitle, useToast, useToday } from '../state/ui';

const FIELDS = [
  'name', 'category', 'amountMinor', 'currency', 'billingFrequency', 'status', 'nextBillingDate', 'trialEndDate', 'startDate', 'anchorDate',
  'paymentMethodLabel', 'websiteUrl', 'cancellationUrl', 'notes', 'usageLevel', 'icon', 'priceChangeEffectiveOn', 'priceChangeNote',
  'remindersEnabled', 'reminderLeadDays',
];

interface FormProps {
  mode: 'create' | 'edit';
  initial: SubscriptionFormValues;
  original?: SubscriptionDto;
  onDone: (s: SubscriptionDto) => void;
  cancelTo: string;
}

function SubscriptionForm({ mode, initial, original, onDone, cancelTo }: FormProps) {
  const today = useToday();
  const { preferences } = useSession();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const set = <K extends keyof SubscriptionFormValues>(key: K, value: SubscriptionFormValues[K]) => setV((cur) => ({ ...cur, [key]: value }));

  const trial = mode === 'create' ? v.status === 'trial' : original?.status === 'trial';
  const amountChanged = mode === 'edit' && original !== undefined && v.amountMinor.trim() !== '' && v.currency === original.currency && v.amountMinor !== initial.amountMinor;
  const frequencyChanged = mode === 'edit' && v.billingFrequency !== initial.billingFrequency;
  const nextDay = Number(v.nextBillingDate.slice(8, 10));
  const showMonthEndHint = !v.anchorDate.trim() || v.anchorDate === v.nextBillingDate ? nextDay >= 28 : false;
  const savedDateHasPassed = mode === 'edit' && original?.status === 'active' && original.nextBillingDate < today;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return; // never submit twice while a request is in flight
    setFormError(null);

    const built = mode === 'create' ? buildCreatePayload(v, { today }) : buildUpdatePayload(v, original!, { today });
    if (!built.ok) {
      setErrors(built.errors);
      if (built.nothingChanged) {
        setFormError('You haven’t changed anything yet.');
        setTimeout(() => document.getElementById('form-error-summary')?.focus(), 0);
      } else setTimeout(() => focusFirstError(built.errors), 0);
      return;
    }

    setErrors({});
    inFlight.current = true;
    setSubmitting(true);
    try {
      const saved = mode === 'create'
        ? await subscriptionsApi.create(built.payload as never)
        : await subscriptionsApi.update(original!.id, built.payload as never);
      invalidate();
      toast({ kind: 'success', message: mode === 'create' ? `Added ${saved.name}.` : `Saved changes to ${saved.name}.` });
      onDone(saved);
    } catch (err) {
      const mapped = mapApiError(err, FIELDS);
      setErrors(mapped.fields);
      setFormError(mapped.form ?? (Object.keys(mapped.fields).length ? 'Please fix the following before continuing:' : null));
      setTimeout(() => (Object.keys(mapped.fields).length ? focusFirstError(mapped.fields) : document.getElementById('form-error-summary')?.focus()), 0);
      if (err instanceof ApiError && err.status === 0) toast({ kind: 'error', message: err.message });
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const advancedHasValue = Boolean(v.startDate !== initial.startDate || v.anchorDate !== initial.anchorDate || errors.startDate || errors.anchorDate);

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      <ErrorSummary errors={errors} formError={formError} />

      <Card aria-labelledby="basics-h" className="space-y-4">
        <h2 id="basics-h" className="text-base">Basics</h2>
        <TextField name="name" label="Service name" value={v.name} onChange={(e) => set('name', e.target.value)} error={errors.name} maxLength={80} autoComplete="off" required />
        <SelectField name="category" label="Category" value={v.category} onChange={(e) => set('category', e.target.value as SubscriptionFormValues['category'])} options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} error={errors.category} />
        <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
          <MoneyField
            name="amountMinor"
            label="Price per billing period"
            currency={v.currency}
            value={v.amountMinor}
            onChange={(e) => set('amountMinor', e.target.value)}
            error={errors.amountMinor}
            hint="What you are charged each time, e.g. 649.00"
            required
          />
          <SelectField name="currency" label="Currency" value={v.currency} onChange={(e) => set('currency', e.target.value as CurrencyCode)} options={CURRENCY_CODES.map((c) => ({ value: c, label: c }))} error={errors.currency} />
        </div>
        <SegmentedField
          name="billingFrequency"
          legend="Billing frequency"
          value={v.billingFrequency}
          onChange={(x) => set('billingFrequency', x as SubscriptionFormValues['billingFrequency'])}
          options={FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }))}
          hint={frequencyChanged ? 'Changing the frequency starts a new schedule: confirm the next billing date below.' : undefined}
        />
        {mode === 'create' ? (
          <SegmentedField
            name="status"
            legend="Is this a free trial?"
            value={v.status}
            onChange={(x) => set('status', x as 'active' | 'trial')}
            options={[{ value: 'active', label: 'No, it’s paid' }, { value: 'trial', label: 'Yes, free trial' }]}
            hint="SubCycle never converts a trial for you: you’ll be reminded on screen to convert it or record a cancellation."
          />
        ) : null}
      </Card>

      <Card aria-labelledby="dates-h" className="space-y-4">
        <h2 id="dates-h" className="text-base">Dates</h2>
        {trial ? (
          <DateField name="trialEndDate" label="Trial ends on" value={v.trialEndDate} onChange={(e) => set('trialEndDate', e.target.value)} error={errors.trialEndDate} required />
        ) : null}
        <DateField
          name="nextBillingDate"
          label={trial ? 'First charge after the trial' : 'Next billing date'}
          value={v.nextBillingDate}
          onChange={(e) => set('nextBillingDate', e.target.value)}
          error={errors.nextBillingDate}
          required={!trial}
          hint={
            savedDateHasPassed
              ? `The saved date (${formatDate(original!.nextBillingDate)}) has passed. SubCycle keeps following your billing day, so only change this if your billing day moved. Changing it starts a new schedule.`
              : mode === 'edit'
                ? 'Changing this starts a new billing schedule from the new date.'
                : trial
                  ? 'Leave blank to use the day the trial ends.'
                  : 'The date of your next charge.'
          }
        />
        {showMonthEndHint ? (
          <p className="rounded-control border border-warn/50 bg-warn-soft px-3 py-2 text-xs text-fg">
            Is your bill normally on the 29th, 30th or 31st? Open “Advanced schedule options” and enter the original billing date, so short months don’t move your billing day.
          </p>
        ) : null}
        <details open={advancedHasValue || undefined} className="rounded-control border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium">Advanced schedule options</summary>
          <div className="mt-4 space-y-4">
            <DateField name="anchorDate" label="Original billing date" optional value={v.anchorDate} onChange={(e) => set('anchorDate', e.target.value)} error={errors.anchorDate} hint="The date your billing day comes from (e.g. Jan 31). Later dates are always calculated from this one." />
            <DateField name="startDate" label="Start date" optional value={v.startDate} onChange={(e) => set('startDate', e.target.value)} error={errors.startDate} hint="Leave blank to use today." />
          </div>
        </details>
      </Card>

      {amountChanged ? (
        <Card aria-labelledby="price-h" className="space-y-4">
          <h2 id="price-h" className="text-base">Price change</h2>
          <CheckboxField name="recordPriceChange" label="Record this in the price history" checked={v.recordPriceChange} onChange={(x) => set('recordPriceChange', x)} hint="Untick if you are only correcting a typo." />
          {v.recordPriceChange ? (
            <>
              <DateField name="priceChangeEffectiveOn" label="Effective from" optional value={v.priceChangeEffectiveOn} onChange={(e) => set('priceChangeEffectiveOn', e.target.value)} error={errors.priceChangeEffectiveOn} hint="Leave blank for today. Can’t be in the future." />
              <TextField name="priceChangeNote" label="Note" optional value={v.priceChangeNote} onChange={(e) => set('priceChangeNote', e.target.value)} error={errors.priceChangeNote} maxLength={500} />
            </>
          ) : null}
        </Card>
      ) : null}

      <Card aria-labelledby="more-h" className="space-y-4">
        <h2 id="more-h" className="text-base">More details</h2>
        <TextField name="paymentMethodLabel" label="Payment method label" optional value={v.paymentMethodLabel} onChange={(e) => set('paymentMethodLabel', e.target.value)} error={errors.paymentMethodLabel} maxLength={40} hint="A short label like “HDFC card ••12”. Never enter a card number or security code." autoComplete="off" />
        <TextField name="websiteUrl" label="Website" optional type="url" value={v.websiteUrl} onChange={(e) => set('websiteUrl', e.target.value)} error={errors.websiteUrl} placeholder="https://" autoComplete="off" />
        <TextField name="cancellationUrl" label="Cancellation page" optional type="url" value={v.cancellationUrl} onChange={(e) => set('cancellationUrl', e.target.value)} error={errors.cancellationUrl} placeholder="https://" hint="The provider’s official page. Cancelling happens on their site; you record it here afterwards." autoComplete="off" />
        <TextArea name="notes" label="Notes" optional value={v.notes} onChange={(e) => set('notes', e.target.value)} error={errors.notes} maxLength={2000} />
        <SelectField name="usageLevel" label="How often do you use it?" optional value={v.usageLevel} onChange={(e) => set('usageLevel', e.target.value as SubscriptionFormValues['usageLevel'])} options={[{ value: '', label: 'Not set' }, ...USAGE_LEVELS.map((u) => ({ value: u, label: USAGE_LABEL[u] }))]} error={errors.usageLevel} hint="Only what you enter is ever shown as usage: SubCycle never guesses." />
        <TextField name="icon" label="Icon" optional value={v.icon} onChange={(e) => set('icon', e.target.value)} error={errors.icon} maxLength={16} hint="One emoji, e.g. 🎬. Otherwise the first letter is used." autoComplete="off" />
      </Card>

      <Card aria-labelledby="remind-h" className="space-y-4">
        <h2 id="remind-h" className="text-base">Reminders</h2>
        <CheckboxField name="remindersEnabled" label="Remind me before this renews" checked={v.remindersEnabled} onChange={(x) => set('remindersEnabled', x)} hint="Reminders follow the schedule you entered. Turn this off to get none for this subscription." />
        <TextField
          name="reminderLeadDays"
          label="Days before"
          optional
          inputMode="numeric"
          value={v.reminderLeadDays}
          onChange={(e) => set('reminderLeadDays', e.target.value)}
          error={errors.reminderLeadDays}
          disabled={!v.remindersEnabled}
          hint={`Leave blank to use your default (${preferences.reminderLeadDays} ${preferences.reminderLeadDays === 1 ? 'day' : 'days'}). 0 means on the day.`}
        />
      </Card>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link to={cancelTo} className="inline-flex min-h-11 items-center justify-center rounded-control border border-strong bg-raised px-4 text-sm font-semibold !text-fg no-underline hover:bg-line">
          Cancel
        </Link>
        <Button type="submit" variant="primary" loading={submitting}>
          {submitting ? 'Saving…' : mode === 'create' ? 'Add subscription' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

export function NewSubscriptionPage() {
  usePageTitle('Add subscription');
  const { preferences } = useSession();
  const navigate = useNavigate();
  const currency: CurrencyCode = isSupportedCurrency(preferences.currency) ? preferences.currency : 'INR';
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl">Add a subscription</h1>
        <p className="mt-1 text-sm text-muted">Enter what you pay for. SubCycle only knows what you tell it: it never connects to your bank or the service.</p>
      </div>
      <SubscriptionForm mode="create" initial={emptyValues(currency)} cancelTo="/subscriptions" onDone={(s) => navigate(`/subscriptions/${s.id}`)} />
    </div>
  );
}

export function EditSubscriptionPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const q = useApi((signal) => subscriptionsApi.get(id, signal), [id]);
  usePageTitle(q.status === 'ready' ? `Edit ${q.data.name}` : 'Edit subscription');

  if (q.status === 'error') {
    return q.error.status === 404 ? (
      <EmptyState title="Subscription not found" icon="search" level={1} action={<Link to="/subscriptions">Back to subscriptions</Link>}>
        It may have been deleted, or the link is wrong.
      </EmptyState>
    ) : (
      <ErrorState error={q.error} onRetry={q.retry} title="We couldn’t load this subscription" level={1} />
    );
  }
  if (q.status !== 'ready') {
    return (
      <LoadingRegion label="Loading subscription">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-6 h-72" />
      </LoadingRegion>
    );
  }
  const s = q.data;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl">Edit {s.name}</h1>
        <p className="mt-1 text-sm text-muted">Only the fields you change are saved. Status changes (pause, cancel, archive) are on the subscription page.</p>
      </div>
      <SubscriptionForm key={s.id} mode="edit" initial={valuesFromSubscription(s)} original={s} cancelTo={`/subscriptions/${s.id}`} onDone={() => navigate(`/subscriptions/${s.id}`)} />
    </div>
  );
}
