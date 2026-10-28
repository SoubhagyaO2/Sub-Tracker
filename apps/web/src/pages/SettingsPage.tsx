import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { CURRENCY_CODES, type CurrencyCode, PASSWORD_MAX, PASSWORD_MIN, isValidTimeZone, type UpdatePreferencesInput } from '@subcycle/shared';
import { ApiError } from '../api/client';
import { accountApi, preferencesApi } from '../api/endpoints';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Card } from '../components/ui/display';
import { ErrorSummary, SelectField, TextField, focusFirstError } from '../components/ui/Field';
import { browserTimeZone } from '../lib/dates';
import { mapApiError, type FieldErrors } from '../lib/forms';
import { ACCOUNT_DELETED_NOTICE, useAuth, useSession } from '../state/auth';
import { useInvalidate } from '../state/data';
import { usePageTitle, useToast } from '../state/ui';

function SectionHeader({ id, title, children }: { id: string; title: string; children?: string }) {
  return (
    <>
      <div className="-mx-4 mb-4 border-b border-line px-4 pb-3 sm:-mx-6 sm:px-6">
        <h2 id={id} className="text-lg">{title}</h2>
        {children ? <p className="mt-1 text-xs text-muted">{children}</p> : null}
      </div>
    </>
  );
}

// ───────────── appearance + region ─────────────

const PREF_FIELDS = ['currency', 'timezone'];

function zoneChoices(current: string): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  let list: string[];
  try {
    list = supported?.('timeZone') ?? [];
  } catch {
    list = [];
  }
  const all = new Set(['UTC', ...list]);
  all.add(current); // an older saved alias (e.g. Asia/Calcutta) must stay selectable
  return [...all].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
}

function nowIn(timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
  } catch {
    return null;
  }
}

function PreferencesCard() {
  const { preferences } = useSession();
  const { setPreferences } = useAuth();
  const invalidate = useInvalidate();
  const toast = useToast();
  const [currency, setCurrency] = useState(preferences.currency);
  const [timezone, setTimezone] = useState(preferences.timezone);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  const zones = useMemo(() => zoneChoices(preferences.timezone), [preferences.timezone]);
  const device = useMemo(browserTimeZone, []);
  const localNow = nowIn(timezone);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    setErrors({});
    setFormError(null);
    if (!isValidTimeZone(timezone)) {
      const next = { timezone: 'Choose a valid time zone.' };
      setErrors(next);
      setTimeout(() => focusFirstError(next), 0);
      return;
    }
    const patch: UpdatePreferencesInput = {};
    if (currency !== preferences.currency) patch.currency = currency as CurrencyCode;
    if (timezone !== preferences.timezone) patch.timezone = timezone;
    if (Object.keys(patch).length === 0) {
      setFormError('You haven’t changed anything yet.');
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      setPreferences(await preferencesApi.update(patch));
      invalidate(); // "today", reminder times and the preferred currency feed other screens
      toast({ kind: 'success', message: 'Settings saved.' });
    } catch (err) {
      const mapped = mapApiError(err, PREF_FIELDS);
      setErrors(mapped.fields);
      setFormError(mapped.form ?? (Object.keys(mapped.fields).length ? 'Please fix the following before continuing:' : null));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <Card aria-labelledby="prefs-h">
      <SectionHeader id="prefs-h" title="Region">Applied everywhere you sign in.</SectionHeader>
      <form onSubmit={save} noValidate className="space-y-5">
        <ErrorSummary errors={errors} formError={formError} />
        <SelectField
          name="currency"
          label="Preferred currency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          options={CURRENCY_CODES.map((c) => ({ value: c, label: c }))}
          error={errors.currency}
          hint="Used as the default for new subscriptions and to list your totals first. Existing subscriptions and payments keep their own currency: nothing is converted, and different currencies are never added together."
        />
        <div className="space-y-2">
          <SelectField
            name="timezone"
            label="Time zone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            options={zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))}
            error={errors.timezone}
            hint={
              <>
                Decides what “today” is, when a renewal counts as upcoming, and when reminders arrive. Saved dates and payments don’t change.
                {localNow ? <> Right now it is {localNow} there.</> : null}
              </>
            }
          />
          {device !== timezone && isValidTimeZone(device) ? (
            <Button size="sm" onClick={() => setTimezone(device)}>
              Use this device’s time zone ({device.replace(/_/g, ' ')})
            </Button>
          ) : null}
        </div>
        <Button type="submit" variant="primary" loading={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
      </form>
    </Card>
  );
}

// ───────────── reminders (managed on the Reminders page) ─────────────

function RemindersSummary() {
  const { preferences, user, features } = useSession();
  const email = !features.emailVerificationAvailable
    ? 'Email reminders are unavailable on this server (no email provider is configured).'
    : !user.emailVerified
      ? 'Email reminders need a verified address.'
      : preferences.emailRemindersEnabled
        ? 'Email reminders are on.'
        : 'Email reminders are off.';
  return (
    <Card aria-labelledby="rem-h">
      <SectionHeader id="rem-h" title="Reminders" />
      <p className="text-sm">
        {preferences.reminderLeadDays === 0 ? 'On the day' : `${preferences.reminderLeadDays} ${preferences.reminderLeadDays === 1 ? 'day' : 'days'} before`} at {String(preferences.reminderHour).padStart(2, '0')}:00 ({preferences.timezone}).{' '}
        In-app reminders are {preferences.inAppReminders ? 'on' : 'off'}. {email}
      </p>
      <p className="mt-3 text-sm">
        <Link to="/reminders">Change reminder settings and see what was delivered</Link>
      </p>
    </Card>
  );
}

// ───────────── profile ─────────────

function ProfileCard() {
  const { user, features } = useSession();
  const { setUser } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user.displayName);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const trimmed = name.trim();
    const next: FieldErrors = {};
    if (!trimmed) next.displayName = 'Enter a name.';
    else if (trimmed.length > 80) next.displayName = 'Use 80 characters or fewer.';
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) {
      setTimeout(() => focusFirstError(next), 0);
      return;
    }
    if (trimmed === user.displayName) {
      setFormError('You haven’t changed anything yet.');
      return;
    }
    setSaving(true);
    try {
      setUser(await accountApi.updateProfile({ displayName: trimmed }));
      toast({ kind: 'success', message: 'Name updated.' });
    } catch (err) {
      const mapped = mapApiError(err, ['displayName']);
      setErrors(mapped.fields);
      setFormError(mapped.form);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card aria-labelledby="profile-h">
      <SectionHeader id="profile-h" title="Account" />
      <dl className="mb-5 text-sm">
        <dt className="text-xs font-semibold uppercase tracking-wider text-muted">Email</dt>
        <dd className="mt-1 break-all">{user.email}</dd>
        <dd className="mt-1 text-xs text-muted">
          {user.emailVerified
            ? 'Verified. The email address can’t be changed in this version.'
            : features.emailVerificationAvailable
              ? <>Not verified yet. <Link to="/reminders">Verify it on the Reminders page</Link> to receive reminder emails. You don’t need to verify it to use SubCycle.</>
              : 'Not verified. Verification is unavailable because this server has no email provider. You don’t need it to use SubCycle.'}
        </dd>
      </dl>
      <form onSubmit={save} noValidate className="space-y-4">
        <ErrorSummary errors={errors} formError={formError} />
        <TextField name="displayName" label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.displayName} />
        <Button type="submit" variant="primary" loading={saving}>{saving ? 'Saving…' : 'Save name'}</Button>
      </form>
    </Card>
  );
}

// ───────────── password ─────────────

const PASSWORD_FIELDS = ['currentPassword', 'newPassword'];

function PasswordCard() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const inFlight = useRef(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const found: FieldErrors = {};
    if (!current) found.currentPassword = 'Enter your current password.';
    if (next.length < PASSWORD_MIN) found.newPassword = `Use at least ${PASSWORD_MIN} characters.`;
    else if (next.length > PASSWORD_MAX) found.newPassword = `Use ${PASSWORD_MAX} characters or fewer.`;
    else if (next === current) found.newPassword = 'Choose a password different from your current one.';
    if (!found.newPassword && again !== next) found.confirmPassword = 'The two new passwords don’t match.';
    setErrors(found);
    setFormError(null);
    setDone(null);
    if (Object.keys(found).length) {
      setTimeout(() => focusFirstError(found), 0);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      const r = await accountApi.changePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setAgain('');
      setDone(r.otherSessionsSignedOut);
      toast({ kind: 'success', message: 'Password changed.' });
    } catch (err) {
      const mapped = mapApiError(err, PASSWORD_FIELDS);
      setErrors(mapped.fields);
      setFormError(mapped.form ?? (Object.keys(mapped.fields).length ? 'Please fix the following before continuing:' : null));
      if (err instanceof ApiError && err.status === 429) setFormError('Too many incorrect attempts. Please wait a while before trying again.');
      setTimeout(() => focusFirstError(mapped.fields), 0);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <Card aria-labelledby="pw-h">
      <SectionHeader id="pw-h" title="Change password">
        {`Changing your password signs you out everywhere else. Use ${PASSWORD_MIN} or more characters; there are no other rules, but common passwords and ones containing your email are refused.`}
      </SectionHeader>
      <form onSubmit={save} noValidate className="space-y-4">
        <ErrorSummary errors={errors} formError={formError} />
        {done !== null ? (
          <p role="status" className="rounded-control border border-accent-text/50 bg-accent-soft px-3 py-2 text-sm">
            Password changed. {done > 0 ? `${done} other ${done === 1 ? 'session was' : 'sessions were'} signed out.` : 'No other sessions were signed in.'} You stay signed in here.
          </p>
        ) : null}
        <TextField name="currentPassword" label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={errors.currentPassword} />
        <TextField name="newPassword" label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} error={errors.newPassword} />
        <TextField name="confirmPassword" label="Repeat the new password" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} error={errors.confirmPassword} />
        <Button type="submit" variant="primary" loading={saving}>{saving ? 'Changing…' : 'Change password'}</Button>
      </form>
    </Card>
  );
}

// ───────────── delete account ─────────────

function DeleteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useSession();
  const { endSessionLocally } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const matches = confirm.trim().toLowerCase() === user.email.toLowerCase();

  function close() {
    if (busy) return;
    setPassword('');
    setConfirm('');
    setErrors({});
    setFormError(null);
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const found: FieldErrors = {};
    if (!password) found.password = 'Enter your password.';
    if (!matches) found.confirmEmail = 'Type your account email exactly to confirm.';
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) {
      setTimeout(() => focusFirstError(found), 0);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      await accountApi.deleteAccount({ password, confirmEmail: confirm.trim() });
      // The server has already ended every session. Leave without calling anything that needs one.
      endSessionLocally(ACCOUNT_DELETED_NOTICE);
    } catch (err) {
      const mapped = mapApiError(err, ['password', 'confirmEmail']);
      setErrors(mapped.fields);
      setFormError(err instanceof ApiError && err.status === 429 ? 'Too many incorrect attempts. Please wait a while before trying again.' : mapped.form);
      setTimeout(() => focusFirstError(mapped.fields), 0);
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissable={!busy}
      title="Delete your account permanently?"
      description="This removes your SubCycle account and everything in it. It can’t be undone."
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Your subscriptions, recorded payments, price history, reminders and settings are deleted from SubCycle right away.</li>
          <li>You are signed out on every device.</li>
          <li>Nothing is cancelled with any provider: your real subscriptions keep billing you until you cancel them there.</li>
          <li>Backups kept by whoever runs this server can still hold your data until they expire; deleting the account doesn’t erase them immediately.</li>
        </ul>
        <ErrorSummary errors={errors} formError={formError} />
        <TextField name="password" label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} data-autofocus />
        <TextField
          name="confirmEmail"
          label={`Type ${user.email} to confirm`}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirmEmail}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={close} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!matches || !password}>
            Delete my account forever
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DangerCard() {
  const [open, setOpen] = useState(false);
  return (
    <Card aria-labelledby="danger-h">
      <SectionHeader id="danger-h" title="Delete account">
        Permanently deletes your account and all of its data. Needs your password.
      </SectionHeader>
      <Button variant="danger" onClick={() => setOpen(true)}>Delete account…</Button>
      <DeleteDialog open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}

export function SettingsPage() {
  usePageTitle('Settings');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl">Settings</h1>
        <p className="mt-1 text-sm text-muted">Your account, your region, and your password.</p>
      </div>
      <PreferencesCard />
      <RemindersSummary />
      <ProfileCard />
      <PasswordCard />
      <DangerCard />
    </div>
  );
}
