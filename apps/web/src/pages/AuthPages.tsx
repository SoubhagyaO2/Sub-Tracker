import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { PASSWORD_MIN, loginSchema, registerSchema } from '@subcycle/shared';
import { ApiError } from '../api/client';
import { Button } from '../components/ui/Button';
import { ErrorSummary, TextField, focusFirstError } from '../components/ui/Field';
import { LogoMark } from '../components/ui/Icon';
import { browserTimeZone } from '../lib/dates';
import { fieldErrorsFromIssues, mapApiError, type FieldErrors } from '../lib/forms';
import { useAuth } from '../state/auth';
import { usePageTitle } from '../state/ui';

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <main id="main" className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-3">
        <LogoMark className="h-10 w-10" />
        <div>
          <p className="text-lg font-semibold leading-tight">SubCycle</p>
          <p className="text-sm text-muted">All your subscriptions. One clear picture.</p>
        </div>
      </div>
      <div className="rounded-card border border-line bg-surface p-6">
        <h1 className="text-2xl">{title}</h1>
        <p className="mt-1 text-sm text-muted">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </div>
      <p className="mt-6 text-center text-sm text-muted">{footer}</p>
    </main>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage() {
  usePageTitle('Sign in');
  const { state, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string; search?: string } } | null)?.from;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);
  const notice = state.status === 'anon' ? state.notice : undefined;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const next: FieldErrors = {};
    if (!email.trim()) next.email = 'Enter your email address.';
    else if (!EMAIL_RE.test(email.trim())) next.email = 'Enter a valid email address.';
    if (!password) next.password = 'Enter your password.';
    if (Object.keys(next).length === 0) {
      const parsed = loginSchema.safeParse({ email, password });
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
      await login({ email: email.trim(), password });
      navigate(from ? `${from.pathname}${from.search ?? ''}` : '/', { replace: true });
    } catch (err) {
      const mapped = mapApiError(err, ['email', 'password']);
      setErrors(mapped.fields);
      // Generic on purpose: the server does not reveal whether the email exists.
      setFormError(err instanceof ApiError && err.status === 401 ? 'Incorrect email or password.' : mapped.form);
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to see your subscriptions."
      footer={<>New to SubCycle? <Link to="/register">Create an account</Link></>}
    >
      {notice ? (
        <p role="status" className="mb-4 rounded-control border border-info bg-info-soft px-3 py-2 text-sm text-fg">
          {notice}
        </p>
      ) : null}
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <ErrorSummary errors={errors} formError={formError} />
        <TextField name="email" label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <TextField name="password" label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} />
        <Button type="submit" variant="primary" className="w-full" loading={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  usePageTitle('Create account');
  const { register } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const next: FieldErrors = {};
    if (!displayName.trim()) next.displayName = 'Enter your name.';
    else if (displayName.trim().length > 80) next.displayName = 'Name must be at most 80 characters.';
    if (!email.trim()) next.email = 'Enter your email address.';
    else if (!EMAIL_RE.test(email.trim())) next.email = 'Enter a valid email address.';
    if (password.length < PASSWORD_MIN) next.password = `Use at least ${PASSWORD_MIN} characters.`;
    else if (password.length > 128) next.password = 'Use at most 128 characters.';
    const payload = { email: email.trim(), password, displayName: displayName.trim(), timezone: browserTimeZone() };
    if (Object.keys(next).length === 0) {
      const parsed = registerSchema.safeParse(payload);
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
      await register(payload);
      navigate('/', { replace: true });
    } catch (err) {
      const mapped = mapApiError(err, ['email', 'password', 'displayName']);
      setErrors(mapped.fields);
      setFormError(mapped.form ?? (Object.keys(mapped.fields).length ? 'Please fix the following before continuing:' : null));
      setTimeout(() => focusFirstError(mapped.fields), 0);
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout title="Create your account" subtitle="Track what you pay for, in one place." footer={<>Already have an account? <Link to="/login">Sign in</Link></>}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <ErrorSummary errors={errors} formError={formError} />
        <TextField name="displayName" label="Name" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} error={errors.displayName} />
        <TextField name="email" label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <TextField
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${PASSWORD_MIN} characters. A longer passphrase is better than a clever short one.`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <p className="text-xs text-muted">
          SubCycle only records what you tell it. It never asks for card numbers or passwords to your other services.
        </p>
        <Button type="submit" variant="primary" className="w-full" loading={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthLayout>
  );
}
