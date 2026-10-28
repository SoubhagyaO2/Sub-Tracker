import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { PASSWORD_MAX, PASSWORD_MIN, passwordResetConfirmSchema, passwordResetRequestSchema } from '@subcycle/shared';
import { ApiError } from '../api/client';
import { authApi } from '../api/endpoints';
import { Button, LinkButton } from '../components/ui/Button';
import { ErrorSummary, TextField, focusFirstError } from '../components/ui/Field';
import { fieldErrorsFromIssues, mapApiError, type FieldErrors } from '../lib/forms';
import { useAuth } from '../state/auth';
import { usePageTitle } from '../state/ui';
import { AuthLayout } from './AuthPages';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Step 1: ask for a reset link. The answer is the same whether or not the address has an account. */
export function ForgotPasswordPage() {
  usePageTitle('Reset password');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const next: FieldErrors = {};
    if (!email.trim()) next.email = 'Enter your email address.';
    else if (!EMAIL_RE.test(email.trim())) next.email = 'Enter a valid email address.';
    else {
      const parsed = passwordResetRequestSchema.safeParse({ email: email.trim() });
      if (!parsed.success) Object.assign(next, fieldErrorsFromIssues(parsed.error.issues));
    }
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) {
      setTimeout(() => focusFirstError(next), 0);
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      await authApi.requestPasswordReset(email.trim());
      setSentTo(email.trim());
    } catch (err) {
      const mapped = mapApiError(err, ['email']);
      setErrors(mapped.fields);
      setFormError(mapped.form ?? (Object.keys(mapped.fields).length ? 'Please fix the following before continuing:' : null));
      setTimeout(() => focusFirstError(mapped.fields), 0);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  if (sentTo) {
    return (
      <AuthLayout title="Check your email" subtitle="One more step." footer={<Link to="/login">Back to sign in</Link>}>
        <div className="space-y-4 text-sm" aria-live="polite">
          <p role="status">
            If an account exists for <strong>{sentTo}</strong>, we have sent a link to choose a new password.
          </p>
          <p className="text-muted">The link works once and expires in an hour. It can take a minute to arrive; check your spam folder too.</p>
          <Button type="button" variant="secondary" onClick={() => setSentTo(null)}>Use a different address</Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your account email and we will send you a link to choose a new password."
      footer={<>Remembered it? <Link to="/login">Sign in</Link></>}
    >
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <ErrorSummary errors={errors} formError={formError} />
        <TextField name="email" label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <Button type="submit" variant="primary" className="w-full" loading={submitting}>
          {submitting ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </AuthLayout>
  );
}

/** The token travels in the URL fragment, which browsers never send to any server. */
function tokenFromHash(hash: string): string | null {
  const m = /(?:^|[#&])token=([A-Za-z0-9_-]+)/.exec(hash);
  return m?.[1] ?? null;
}

/** Step 2: the page the emailed (or operator-printed) link opens. The token is the credential, so no sign-in is needed. */
export function ResetPasswordPage() {
  usePageTitle('Choose a new password');
  const { refresh } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [token, setToken] = useState<string | null>(() => tokenFromHash(location.hash));
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);

  // A reset link (another one, in the same tab) always starts fresh, and the secret is kept out of the address bar and history once read.
  useEffect(() => {
    const fromUrl = tokenFromHash(location.hash);
    if (!fromUrl) return;
    setToken(fromUrl);
    setInvalid(false);
    setDone(false);
    setPassword('');
    setRepeat('');
    setErrors({});
    setFormError(null);
    navigate(location.pathname + location.search, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || !token) return;
    const next: FieldErrors = {};
    if (password.length < PASSWORD_MIN) next.newPassword = 'Use at least ' + PASSWORD_MIN + ' characters.';
    else if (password.length > PASSWORD_MAX) next.newPassword = 'Use at most ' + PASSWORD_MAX + ' characters.';
    if (!next.newPassword && repeat !== password) next.repeat = 'The two passwords do not match.';
    if (Object.keys(next).length === 0) {
      const parsed = passwordResetConfirmSchema.safeParse({ token, newPassword: password });
      if (!parsed.success) Object.assign(next, fieldErrorsFromIssues(parsed.error.issues));
    }
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length > 0) {
      setTimeout(() => focusFirstError(next), 0);
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      await authApi.confirmPasswordReset({ token, newPassword: password });
      setPassword('');
      setRepeat('');
      setDone(true);
      await refresh(); // every session was ended by the server: drop any stale signed-in state in this browser
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setInvalid(true);
      } else {
        const mapped = mapApiError(err, ['newPassword']);
        setErrors(mapped.fields);
        setFormError(mapped.form ?? (Object.keys(mapped.fields).length ? 'Please fix the following before continuing:' : null));
        setTimeout(() => focusFirstError(mapped.fields), 0);
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const footer = <Link to="/login">Back to sign in</Link>;

  if (done) {
    return (
      <AuthLayout title="Password changed" subtitle="You can sign in with your new password." footer={footer}>
        <div className="space-y-4 text-sm" aria-live="polite">
          <p role="status">Your password has been changed and you were signed out on every device.</p>
          <LinkButton to="/login" variant="primary">Sign in</LinkButton>
        </div>
      </AuthLayout>
    );
  }

  if (!token || invalid) {
    return (
      <AuthLayout title="Link not valid" subtitle="We could not use this password reset link." footer={footer}>
        <div className="space-y-4 text-sm">
          <p role="alert">
            {invalid
              ? 'This reset link is invalid or has expired. Links work once and last an hour.'
              : 'This page needs the link from your password reset email. Open the link again, or request a new one.'}
          </p>
          <LinkButton to="/forgot-password" variant="primary">Request a new link</LinkButton>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Choose a new password" subtitle="You will be signed out everywhere and asked to sign in again." footer={footer}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <ErrorSummary errors={errors} formError={formError} />
        <TextField
          name="newPassword"
          label="New password"
          type="password"
          autoComplete="new-password"
          hint={'At least ' + PASSWORD_MIN + ' characters. A longer passphrase is better than a clever short one.'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.newPassword}
        />
        <TextField name="repeat" label="Repeat the new password" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} error={errors.repeat} />
        <Button type="submit" variant="primary" className="w-full" loading={submitting}>
          {submitting ? 'Saving…' : 'Change password'}
        </Button>
      </form>
    </AuthLayout>
  );
}
