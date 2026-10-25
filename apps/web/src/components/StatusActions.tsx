import { useRef, useState, type FormEvent } from 'react';
import { rollForwardDate, type DateOnly, type StatusAction, type StatusActionInput, type SubscriptionDto } from '@subcycle/shared';
import { ApiError } from '../api/client';
import { subscriptionsApi } from '../api/endpoints';
import { formatDate } from '../lib/dates';
import { mapApiError, type FieldErrors } from '../lib/forms';
import { ACTION_LABEL } from '../lib/labels';
import { useInvalidate } from '../state/data';
import { useToast } from '../state/ui';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { DateField, ErrorSummary, focusFirstError } from './ui/Field';
import { Icon, type IconName } from './ui/Icon';

const ACTION_ICON: Record<StatusAction, IconName> = { pause: 'pause', resume: 'play', convert: 'convert', cancel: 'ban', archive: 'archive', restore: 'restore' };

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Buttons for exactly the actions the server says are allowed right now (allowedActions), one dialog each. */
export function StatusActions({ s, today }: { s: SubscriptionDto; today: DateOnly }) {
  const [action, setAction] = useState<StatusAction | null>(null);
  return (
    <>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Status actions">
        {(s.allowedActions as StatusAction[]).map((a) => (
          <Button key={a} size="sm" variant={a === 'cancel' ? 'danger' : 'secondary'} onClick={() => setAction(a)}>
            <Icon name={ACTION_ICON[a]} className="h-4 w-4" />
            {ACTION_LABEL[a]}
          </Button>
        ))}
      </div>
      {action ? <StatusDialog key={action} action={action} s={s} today={today} onClose={() => setAction(null)} /> : null}
    </>
  );
}

const COPY: Record<StatusAction, { title: (n: string) => string; body: (n: string) => string; confirm: string; done: (n: string) => string }> = {
  pause: {
    title: (n) => `Pause ${n}?`,
    body: (n) => `It will stop counting in your totals and upcoming renewals. This only changes what SubCycle shows: it doesn’t pause anything with ${n}.`,
    confirm: 'Pause',
    done: (n) => `Paused ${n}.`,
  },
  resume: {
    title: (n) => `Resume ${n}?`,
    body: () => 'It will count in your totals and upcoming renewals again. Check the next billing date below.',
    confirm: 'Resume',
    done: (n) => `Resumed ${n}.`,
  },
  convert: {
    title: (n) => `Convert ${n} to a paid subscription?`,
    body: () => 'Use this once your trial has turned into a paid plan. SubCycle never converts trials on its own.',
    confirm: 'Convert trial',
    done: (n) => `${n} is now an active subscription.`,
  },
  cancel: {
    title: (n) => `Record that you cancelled ${n}`,
    body: () => '',
    confirm: 'Record cancellation',
    done: (n) => `Recorded your cancellation of ${n}. SubCycle hasn’t cancelled anything with the provider.`,
  },
  archive: {
    title: (n) => `Archive ${n}?`,
    body: () => 'It will be hidden from your lists, totals and renewals. You can restore it later and nothing is deleted.',
    confirm: 'Archive',
    done: (n) => `Archived ${n}.`,
  },
  restore: {
    title: (n) => `Restore ${n}?`,
    body: () => '',
    confirm: 'Restore',
    done: (n) => `Restored ${n}.`,
  },
};

function StatusDialog({ action, s, today, onClose }: { action: StatusAction; s: SubscriptionDto; today: DateOnly; onClose: () => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const copy = COPY[action];
  const suggestion = rollForwardDate(s.anchorDate, s.billingFrequency, s.nextBillingDate, today);
  const storedHasPassed = s.nextBillingDate < today;

  // Which dates this action asks for.
  const restoringCancelled = action === 'restore' && s.status === 'cancelled';
  const needsNextDate = action === 'resume' || action === 'convert' || restoringCancelled;
  // Restoring from the archive only asks for a date if the server says the old one is no longer usable.
  const [askRestoreDate, setAskRestoreDate] = useState(false);
  const showNext = needsNextDate || (action === 'restore' && askRestoreDate);

  const [next, setNext] = useState(storedHasPassed || restoringCancelled || askRestoreDate ? suggestion : s.nextBillingDate);
  const [cancelledOn, setCancelledOn] = useState(today);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const host = hostOf(s.cancellationUrl ?? s.websiteUrl);
  const link = s.cancellationUrl ?? s.websiteUrl;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const body: StatusActionInput = { action };
    const localErrors: FieldErrors = {};
    if (showNext) {
      if (!next) localErrors.nextBillingDate = 'Enter the next billing date.';
      else if (next < today) localErrors.nextBillingDate = 'Next billing date can’t be in the past.';
      // Send a date only when it is needed or changed: omitting it keeps the existing billing schedule intact.
      else if (restoringCancelled || storedHasPassed || next !== s.nextBillingDate || askRestoreDate) body.nextBillingDate = next;
    }
    if (action === 'cancel') {
      if (!cancelledOn) localErrors.cancelledOn = 'Enter the date you cancelled.';
      else if (cancelledOn > today) localErrors.cancelledOn = 'Record the cancellation after you’ve completed it: the date can’t be in the future.';
      else if (cancelledOn < s.startDate) localErrors.cancelledOn = 'The date can’t be before the start date.';
      else body.cancelledOn = cancelledOn;
    }
    setErrors(localErrors);
    setFormError(null);
    if (Object.keys(localErrors).length) {
      setTimeout(() => focusFirstError(localErrors), 0);
      return;
    }

    inFlight.current = true;
    setBusy(true);
    try {
      await subscriptionsApi.transition(s.id, body);
      invalidate();
      toast({ kind: 'success', message: copy.done(s.name) });
      onClose();
    } catch (err) {
      const mapped = mapApiError(err, ['nextBillingDate', 'cancelledOn']);
      if (action === 'restore' && !showNext && mapped.fields.nextBillingDate) {
        // The archived subscription needs a fresh billing date; ask for it and let them confirm.
        setAskRestoreDate(true);
        setNext(suggestion);
        setFormError('This subscription’s saved billing date has passed. Confirm the next billing date to restore it.');
        mapped.fields = {};
      } else {
        setErrors(mapped.fields);
        setFormError(mapped.form);
        if (err instanceof ApiError && err.status === 409) invalidate(); // state changed elsewhere: refresh what we show
        setTimeout(() => (Object.keys(mapped.fields).length ? focusFirstError(mapped.fields) : document.getElementById('form-error-summary')?.focus()), 0);
      }
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={copy.title(s.name)} description={copy.body(s.name) || undefined} dismissable={!busy}>
      <form onSubmit={submit} noValidate className="space-y-4">

        {action === 'cancel' ? (
          <div className="space-y-3 text-sm text-muted">
            <p>
              <strong className="text-fg">SubCycle can’t cancel {s.name} for you.</strong> Cancelling happens on the provider’s side. Do that first, then record it here so your totals and renewals are accurate.
            </p>
            {link ? (
              <p>
                <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 font-medium">
                  Open {host ?? 'the official'} {s.cancellationUrl ? 'cancellation page' : 'website'}
                  <Icon name="external" className="h-4 w-4" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </p>
            ) : (
              <p>You haven’t saved a cancellation link for this subscription. You can add one by editing it.</p>
            )}
            <p>This only records your own status. It doesn’t contact {s.name}, and SubCycle can’t confirm the cancellation worked.</p>
          </div>
        ) : null}

        {restoringCancelled ? (
          <p className="text-sm text-muted">Restoring a cancelled subscription means you’ve signed up again. Confirm when it next bills. This doesn’t re-subscribe you with {s.name}.</p>
        ) : null}

        <ErrorSummary errors={errors} formError={formError} />

        {action === 'cancel' ? (
          <DateField name="cancelledOn" label="Date you cancelled" value={cancelledOn} max={today} onChange={(e) => setCancelledOn(e.target.value)} error={errors.cancelledOn} data-autofocus />
        ) : null}
        {showNext ? (
          <DateField
            name="nextBillingDate"
            label="Next billing date"
            value={next}
            min={today}
            onChange={(e) => setNext(e.target.value)}
            error={errors.nextBillingDate}
            hint={storedHasPassed ? `The saved date (${formatDate(s.nextBillingDate)}) has passed, so this is suggested from your billing schedule.` : 'Leave as it is to keep your current schedule.'}
            data-autofocus
          />
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onClose} disabled={busy} {...(!showNext && action !== 'cancel' ? { 'data-autofocus': true } : {})}>
            Keep as it is
          </Button>
          <Button type="submit" variant={action === 'cancel' ? 'danger' : 'primary'} loading={busy}>
            {copy.confirm}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
