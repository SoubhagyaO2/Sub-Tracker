import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { PreferencesDto, ReminderDto, ReminderStatus, SkipReason, UpdatePreferencesInput } from '@subcycle/shared';
import { ApiError } from '../api/client';
import { accountApi, preferencesApi, remindersApi, type ReminderListParams } from '../api/endpoints';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, EmptyState, ErrorState, LoadingRegion, Pagination, Skeleton } from '../components/ui/display';
import { CheckboxField, ErrorSummary, SelectField, TextField, focusFirstError } from '../components/ui/Field';
import { Icon, type IconName } from '../components/ui/Icon';
import { formatDate } from '../lib/dates';
import { mapApiError, type FieldErrors } from '../lib/forms';
import { useApi, useInvalidate } from '../state/data';
import { useAuth, useSession } from '../state/auth';
import { usePageTitle, useToast } from '../state/ui';

/** Why a reminder was skipped, in words a person can act on. */
export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  smtp_not_configured: 'This server has no email provider configured.',
  email_not_verified: 'Your email address isn’t verified.',
  email_disabled: 'Email reminders were turned off.',
  subscription_inactive: 'The subscription was no longer active.',
  delivery_window_missed: 'It couldn’t be delivered before the renewal date, so it wasn’t sent late.',
  invalid_time_zone: 'Your saved time zone isn’t valid, so the time couldn’t be worked out.',
};

const STATUS_STYLE: Record<ReminderStatus, { label: string; icon: IconName; cls: string }> = {
  sent: { label: 'Sent', icon: 'check', cls: 'border-accent-text/50 bg-accent-soft text-accent-text' },
  pending: { label: 'Scheduled', icon: 'clock', cls: 'border-info/50 bg-info-soft text-info' },
  skipped: { label: 'Skipped', icon: 'ban', cls: 'border-warn/50 bg-warn-soft text-warn' },
  failed: { label: 'Failed', icon: 'alert', cls: 'border-danger/50 bg-danger-soft text-danger' },
  superseded: { label: 'Replaced', icon: 'archive', cls: 'border-strong bg-raised text-muted' },
};

function useDateTime() {
  const { preferences } = useSession();
  return (iso: string) => {
    const opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
    try {
      return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: preferences.timezone }).format(new Date(iso));
    } catch {
      return new Intl.DateTimeFormat(undefined, opts).format(new Date(iso));
    }
  };
}

function StatusBadge({ r }: { r: ReminderDto }) {
  const s = STATUS_STYLE[r.status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${s.cls}`}>
      <Icon name={s.icon} className="h-3.5 w-3.5" />
      {s.label}
    </span>
  );
}

const subject = (r: ReminderDto) => (r.kind === 'trial_end' ? `${r.subscriptionName} free trial ends` : `${r.subscriptionName} renews`);

function outcome(r: ReminderDto, fmt: (iso: string) => string): string {
  switch (r.status) {
    case 'sent':
      return r.channel === 'in_app' ? `In your inbox since ${fmt(r.sentAt!)}.` : `Accepted by the email server at ${fmt(r.sentAt!)}. SubCycle can’t see whether it reached your inbox.`;
    case 'pending':
      return r.attempts > 0 && r.lastError ? `Couldn’t be sent yet (${r.lastError}). SubCycle will try again automatically.` : `Scheduled for ${fmt(r.remindAt)}.`;
    case 'skipped':
      return `Not sent: ${SKIP_REASON_TEXT[r.skipReason ?? 'smtp_not_configured']}`;
    case 'failed':
      return `Couldn’t be sent${r.lastError ? ` (${r.lastError})` : ''}. SubCycle stopped trying.`;
    case 'superseded':
      return 'Replaced after a change to the subscription or your settings.';
  }
}

// ───────────── inbox ─────────────

function Inbox() {
  const invalidate = useInvalidate();
  const toast = useToast();
  const fmt = useDateTime();
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const q = useApi((signal) => remindersApi.list({ channel: 'in_app', status: ['sent'], page, pageSize: 10 }, signal), [page]);

  async function dismiss(r: ReminderDto) {
    setBusyId(r.id);
    try {
      await remindersApi.dismiss(r.id);
      invalidate();
    } catch (err) {
      toast({ kind: 'error', message: err instanceof ApiError ? err.message : 'Couldn’t mark that as read.' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card aria-labelledby="inbox-h">
      <CardHeader id="inbox-h" title="Inbox" />
      {q.status === 'error' ? (
        <ErrorState error={q.error} onRetry={q.retry} title="We couldn’t load your reminders" />
      ) : q.status !== 'ready' ? (
        <LoadingRegion label="Loading reminders"><Skeleton className="h-24" /></LoadingRegion>
      ) : q.data.meta.total === 0 ? (
        <EmptyState title="No reminders yet" icon="clock">
          Reminders appear here shortly before a renewal or the end of a free trial, at the time and lead you choose below.
        </EmptyState>
      ) : (
        <>
          <ul className="divide-y divide-line" aria-busy={q.refreshing || undefined}>
            {q.data.items.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0 text-sm">
                  <p className={r.readAt ? 'text-muted' : 'font-semibold'}>
                    <Link to={`/subscriptions/${r.subscriptionId}`} className="!text-inherit">{subject(r)}</Link> on {formatDate(r.targetDate)}
                    {!r.readAt ? <span className="ml-2 rounded-full bg-accent px-2 py-0.5 align-middle text-xs font-semibold text-accent-fg">New</span> : null}
                  </p>
                  <p className="text-xs text-muted">{r.leadDays === 0 ? 'On the day' : `${r.leadDays} ${r.leadDays === 1 ? 'day' : 'days'} before`} · delivered {fmt(r.sentAt!)}</p>
                </div>
                {!r.readAt ? (
                  <Button size="sm" loading={busyId === r.id} onClick={() => void dismiss(r)} aria-label={`Mark as read: reminder for ${r.subscriptionName}`}>
                    Mark as read
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <Pagination page={q.data.meta.page} pageSize={q.data.meta.pageSize} total={q.data.meta.total} onPage={setPage} label="Inbox pagination" />
        </>
      )}
    </Card>
  );
}

// ───────────── delivery log ─────────────

function DeliveryLog() {
  const fmt = useDateTime();
  const [page, setPage] = useState(1);
  const [channel, setChannel] = useState<'' | 'in_app' | 'email'>('');
  const params: ReminderListParams = { page, pageSize: 15, ...(channel ? { channel } : {}) };
  const q = useApi((signal) => remindersApi.list(params, signal), [page, channel]);

  return (
    <Card aria-labelledby="log-h">
      <CardHeader id="log-h" title="Delivery log" />
      <p className="mb-4 text-xs text-muted">
        Every reminder SubCycle planned and what happened to it. “Sent” for email means the email server accepted it: SubCycle can’t see your inbox.
      </p>
      <div className="mb-4 max-w-[14rem]">
        <SelectField name="logChannel" label="Show" value={channel} onChange={(e) => { setChannel(e.target.value as typeof channel); setPage(1); }} options={[{ value: '', label: 'All reminders' }, { value: 'in_app', label: 'In-app only' }, { value: 'email', label: 'Email only' }]} />
      </div>
      {q.status === 'error' ? (
        <ErrorState error={q.error} onRetry={q.retry} title="We couldn’t load the delivery log" />
      ) : q.status !== 'ready' ? (
        <LoadingRegion label="Loading delivery log"><Skeleton className="h-32" /></LoadingRegion>
      ) : q.data.meta.total === 0 ? (
        <p className="text-sm text-muted">Nothing has been planned yet. Reminders are planned automatically for active subscriptions and free trials.</p>
      ) : (
        <>
          <ul className="divide-y divide-line" aria-busy={q.refreshing || undefined}>
            {q.data.items.map((r) => (
              <li key={r.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge r={r} />
                  <span className="font-medium">{subject(r)} {formatDate(r.targetDate, { weekday: false })}</span>
                  <span className="text-xs text-muted">· {r.channel === 'email' ? 'Email' : 'In-app'}</span>
                </div>
                <p className="mt-1 text-xs text-muted">{outcome(r, fmt)}</p>
              </li>
            ))}
          </ul>
          <Pagination page={q.data.meta.page} pageSize={q.data.meta.pageSize} total={q.data.meta.total} onPage={setPage} label="Delivery log pagination" />
        </>
      )}
    </Card>
  );
}

// ───────────── settings ─────────────

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));
const FIELDS = ['reminderLeadDays', 'reminderHour', 'inAppReminders', 'emailRemindersEnabled', 'trialRemindersEnabled'];

function EmailAvailability() {
  const { user, features } = useSession();
  const { refresh } = useAuth();
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'sent' | 'error'; message?: string }>({ kind: 'idle' });

  if (!features.emailVerificationAvailable) {
    return (
      <p role="note" className="rounded-control border border-warn/50 bg-warn-soft px-3 py-2 text-sm">
        <strong>Email reminders aren’t available on this server</strong> because no email provider is configured. You’ll still get in-app reminders above. If you turn email on anyway, each email reminder is recorded as skipped, never as sent.
      </p>
    );
  }
  if (user.emailVerified) {
    return <p className="text-sm text-muted"><Icon name="check" className="mr-1 inline h-4 w-4 text-accent-text" />{user.email} is verified. Reminder emails go to this address.</p>;
  }

  async function send() {
    setState({ kind: 'sending' });
    try {
      await accountApi.sendVerification();
      setState({ kind: 'sent' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await refresh();
        return;
      }
      setState({ kind: 'error', message: err instanceof ApiError ? err.message : 'Something went wrong. Please try again.' });
    }
  }

  return (
    <div className="space-y-2 rounded-control border border-line p-3 text-sm">
      <p><strong>Verify your email address to receive reminders by email.</strong> We only send reminders to an address you’ve confirmed.</p>
      {state.kind === 'sent' ? <p role="status" className="text-accent-text">Verification email sent to {user.email}. Open the link in it to finish, then come back here.</p> : null}
      {state.kind === 'error' ? <p role="alert" className="text-danger">{state.message}</p> : null}
      <Button size="sm" onClick={() => void send()} loading={state.kind === 'sending'}>
        {state.kind === 'sent' ? 'Send it again' : 'Send verification email'}
      </Button>
    </div>
  );
}

function Settings() {
  const { preferences, user, features } = useSession();
  const { setPreferences } = useAuth();
  const invalidate = useInvalidate();
  const toast = useToast();
  const [lead, setLead] = useState(String(preferences.reminderLeadDays));
  const [hour, setHour] = useState(String(preferences.reminderHour));
  const [inApp, setInApp] = useState(preferences.inAppReminders);
  const [email, setEmail] = useState(preferences.emailRemindersEnabled);
  const [trial, setTrial] = useState(preferences.trialRemindersEnabled);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const emailUsable = features.emailVerificationAvailable && user.emailVerified;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const next: FieldErrors = {};
    const leadN = Number(lead);
    if (lead.trim() === '' || !/^\d{1,2}$/.test(lead.trim()) || leadN > 60) next.reminderLeadDays = 'Enter a whole number of days from 0 to 60.';
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) {
      setTimeout(() => focusFirstError(next), 0);
      return;
    }
    const patch: UpdatePreferencesInput = {};
    if (leadN !== preferences.reminderLeadDays) patch.reminderLeadDays = leadN;
    if (Number(hour) !== preferences.reminderHour) patch.reminderHour = Number(hour);
    if (inApp !== preferences.inAppReminders) patch.inAppReminders = inApp;
    if (email !== preferences.emailRemindersEnabled) patch.emailRemindersEnabled = email;
    if (trial !== preferences.trialRemindersEnabled) patch.trialRemindersEnabled = trial;
    if (Object.keys(patch).length === 0) {
      setFormError('You haven’t changed anything yet.');
      return;
    }
    setSaving(true);
    try {
      const updated: PreferencesDto = await preferencesApi.update(patch);
      setPreferences(updated);
      invalidate();
      toast({ kind: 'success', message: 'Reminder settings saved.' });
    } catch (err) {
      const mapped = mapApiError(err, FIELDS);
      setErrors(mapped.fields);
      setFormError(mapped.form ?? (Object.keys(mapped.fields).length ? 'Please fix the following before continuing:' : null));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card aria-labelledby="settings-h">
      <h2 id="settings-h" className="mb-1 text-base">Reminder settings</h2>
      <p className="mb-4 text-xs text-muted">Times use your time zone ({preferences.timezone}). Each subscription can override the lead time when you edit it.</p>
      <form onSubmit={save} noValidate className="space-y-4">
        <ErrorSummary errors={errors} formError={formError} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="reminderLeadDays" label="Remind me this many days before" inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value)} error={errors.reminderLeadDays} hint="0 means on the day itself." />
          <SelectField name="reminderHour" label="At this time" value={hour} onChange={(e) => setHour(e.target.value)} options={HOURS} error={errors.reminderHour} />
        </div>
        <CheckboxField name="inAppReminders" label="Show reminders in SubCycle" checked={inApp} onChange={setInApp} hint="They appear in the inbox above." />
        <CheckboxField name="trialRemindersEnabled" label="Remind me when a free trial is about to end" checked={trial} onChange={setTrial} />
        <div className="space-y-3">
          <CheckboxField
            name="emailRemindersEnabled"
            label="Also email me"
            checked={email}
            onChange={setEmail}
            disabled={!emailUsable && !preferences.emailRemindersEnabled}
            hint={emailUsable ? 'Sent to your verified address.' : 'Available once email is set up and your address is verified.'}
          />
          <EmailAvailability />
        </div>
        <Button type="submit" variant="primary" loading={saving}>{saving ? 'Saving…' : 'Save reminder settings'}</Button>
      </form>
    </Card>
  );
}

export function RemindersPage() {
  usePageTitle('Reminders');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl">Reminders</h1>
        <p className="mt-1 text-sm text-muted">
          SubCycle reminds you before a renewal using the schedule you entered. It doesn’t know whether a charge will actually happen, and it can’t cancel anything for you.
        </p>
      </div>
      <Inbox />
      <Settings />
      <DeliveryLog />
    </div>
  );
}
