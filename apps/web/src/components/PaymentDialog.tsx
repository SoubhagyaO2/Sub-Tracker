import { useMemo, useRef, useState, type FormEvent } from 'react';
import {
  CURRENCY_CODES,
  PAYMENT_STATUSES,
  addDays,
  compareDates,
  createPaymentSchema,
  isValidDateOnly,
  occurrencesBetween,
  type CreatePaymentInput,
  type CurrencyCode,
  type DateOnly,
  type PaymentStatus,
  type SubscriptionDto,
} from '@subcycle/shared';
import { ApiError } from '../api/client';
import { paymentsApi } from '../api/endpoints';
import { formatDate } from '../lib/dates';
import { fieldErrorsFromIssues, mapApiError, type FieldErrors } from '../lib/forms';
import { PAYMENT_STATUS_LABEL } from '../lib/labels';
import { minorToInput, parseMoneyInput } from '../lib/money';
import { useInvalidate } from '../state/data';
import { useToast } from '../state/ui';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { CheckboxField, DateField, ErrorSummary, MoneyField, SegmentedField, SelectField, TextField, focusFirstError } from './ui/Field';

const FIELDS = ['amountMinor', 'currency', 'paidOn', 'status', 'forBillingDate', 'note', 'advanceNextBillingDate'];
const SPAN_DAYS = { weekly: 35, monthly: 125, quarterly: 280, yearly: 1100 } as const;

/**
 * The renewals a payment can say it covers: the upcoming one (for an active subscription) and the few
 * before it. Offering these (instead of a free date) keeps forBillingDate on the billing schedule, which is
 * what makes the server's duplicate-payment guard effective.
 */
export function renewalChoices(s: SubscriptionDto, today: DateOnly): { dates: DateOnly[]; upcoming: DateOnly | null } {
  const upcoming = s.status === 'active' ? s.effectiveNextBillingDate : null;
  const ref = upcoming ?? today;
  const from = addDays(ref, -SPAN_DAYS[s.billingFrequency]);
  const all = occurrencesBetween(s.anchorDate, s.billingFrequency, from, ref);
  return { dates: all.slice(-4).reverse(), upcoming };
}

export function PaymentDialog({ s, today, onClose }: { s: SubscriptionDto; today: DateOnly; onClose: () => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const choices = useMemo(() => renewalChoices(s, today), [s, today]);

  const [amount, setAmount] = useState(minorToInput(s.amountMinor, s.currency));
  const [currency, setCurrency] = useState<CurrencyCode>(s.currency);
  const [paidOn, setPaidOn] = useState(today);
  const [status, setStatus] = useState<PaymentStatus>('paid');
  const [forDate, setForDate] = useState<string>(choices.upcoming ?? '');
  const [note, setNote] = useState('');
  const [advanceOverride, setAdvanceOverride] = useState<boolean | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  // Moving the next billing date is only possible for a paid payment on an active subscription that names a renewal.
  const canAdvance = s.status === 'active' && status === 'paid' && forDate !== '';
  const advance = canAdvance && (advanceOverride ?? forDate === choices.upcoming);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const next: FieldErrors = {};
    const money = parseMoneyInput(amount, currency);
    if (!money.ok) next.amountMinor = money.message;
    if (!isValidDateOnly(paidOn)) next.paidOn = 'Enter the date you paid.';
    else if (compareDates(paidOn, today) > 0) next.paidOn = 'A payment can’t be dated in the future. Record it once it has been made.';

    let payload: CreatePaymentInput | null = null;
    if (Object.keys(next).length === 0 && money.ok) {
      const candidate: CreatePaymentInput = {
        amountMinor: money.minor,
        currency,
        paidOn,
        status,
        ...(forDate ? { forBillingDate: forDate } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(advance ? { advanceNextBillingDate: true } : {}),
      };
      const parsed = createPaymentSchema.safeParse(candidate);
      if (parsed.success) payload = parsed.data;
      else Object.assign(next, fieldErrorsFromIssues(parsed.error.issues));
    }
    setErrors(next);
    setFormError(null);
    if (!payload) {
      setTimeout(() => focusFirstError(next), 0);
      return;
    }

    inFlight.current = true;
    setBusy(true);
    try {
      const result = await paymentsApi.create(s.id, payload);
      invalidate();
      toast({
        kind: 'success',
        message: result.nextBillingDateAdvanced
          ? `Payment recorded. Next billing date moved to ${formatDate(result.subscription.nextBillingDate)}.`
          : 'Payment recorded.',
      });
      onClose();
    } catch (err) {
      const mapped = mapApiError(err, FIELDS);
      setErrors(mapped.fields);
      setFormError(mapped.form ?? (Object.keys(mapped.fields).length ? 'Please fix the following before continuing:' : null));
      setTimeout(() => (Object.keys(mapped.fields).length ? focusFirstError(mapped.fields) : document.getElementById('form-error-summary')?.focus()), 0);
      if (err instanceof ApiError && err.status === 409) invalidate();
      inFlight.current = false;
      setBusy(false);
    }
  }

  const renewalOptions = [
    { value: '', label: 'Not tied to a particular renewal' },
    ...choices.dates.map((d) => ({ value: d, label: `${formatDate(d)}${d === choices.upcoming ? ' (next renewal)' : ''}` })),
  ];

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Record a payment for ${s.name}`}
      description="You are recording something you paid. SubCycle doesn’t check it against your bank or the provider."
      dismissable={!busy}
      size="lg"
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <ErrorSummary errors={errors} formError={formError} />
        <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
          <MoneyField name="amountMinor" label="Amount paid" currency={currency} value={amount} onChange={(e) => setAmount(e.target.value)} error={errors.amountMinor} data-autofocus />
          <SelectField name="currency" label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value as CurrencyCode)} options={CURRENCY_CODES.map((c) => ({ value: c, label: c }))} error={errors.currency} />
        </div>
        {currency !== s.currency ? (
          <p className="text-xs text-muted">This differs from the subscription’s currency ({s.currency}). It’s recorded as entered and reported separately; nothing is converted.</p>
        ) : null}
        <DateField name="paidOn" label="Paid on" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} error={errors.paidOn} />
        <SegmentedField name="status" legend="Result" value={status} onChange={(x) => setStatus(x as PaymentStatus)} options={PAYMENT_STATUSES.map((p) => ({ value: p, label: PAYMENT_STATUS_LABEL[p] }))} />
        <SelectField
          name="forBillingDate"
          label="Which renewal does this cover?"
          value={forDate}
          onChange={(e) => setForDate(e.target.value)}
          options={renewalOptions}
          error={errors.forBillingDate}
          hint="Choosing the renewal lets SubCycle warn you if you record the same renewal twice."
        />
        <CheckboxField
          name="advanceNextBillingDate"
          label="Move the next billing date forward after this payment"
          checked={advance}
          disabled={!canAdvance}
          onChange={(x) => setAdvanceOverride(x)}
          hint={
            canAdvance
              ? 'Keeps your billing schedule: it moves to the following billing date.'
              : s.status !== 'active'
                ? 'Only available for an active subscription.'
                : status !== 'paid'
                  ? 'Only available for a paid payment.'
                  : 'Choose which renewal this covers to enable this.'
          }
        />
        <TextField name="note" label="Note" optional value={note} onChange={(e) => setNote(e.target.value)} error={errors.note} maxLength={500} autoComplete="off" hint="Never enter card numbers." />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>{busy ? 'Recording…' : 'Record payment'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
