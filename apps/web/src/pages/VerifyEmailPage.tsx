import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError } from '../api/client';
import { accountApi } from '../api/endpoints';
import { LinkButton, Spinner } from '../components/ui/Button';
import { LogoMark } from '../components/ui/Icon';
import { useAuth } from '../state/auth';
import { usePageTitle } from '../state/ui';

type State = { kind: 'checking' } | { kind: 'done' } | { kind: 'invalid'; message: string } | { kind: 'missing' } | { kind: 'error'; message: string };

/** Landing page for the link in the verification email. The emailed token is the credential, so no sign-in is required. */
export function VerifyEmailPage() {
  usePageTitle('Verify email');
  const [params] = useSearchParams();
  const token = params.get('token');
  const { state: auth, refresh } = useAuth();
  const [state, setState] = useState<State>(token ? { kind: 'checking' } : { kind: 'missing' });
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return; // the token is single-use: never submit it twice (StrictMode runs effects twice in development)
    ran.current = true;
    accountApi
      .confirmVerification(token)
      .then(async () => {
        setState({ kind: 'done' });
        await refresh();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && (err.status === 400 || err.status === 422)) setState({ kind: 'invalid', message: err.message });
        else setState({ kind: 'error', message: err instanceof ApiError ? err.message : 'Something went wrong. Please try again.' });
      });
  }, [token, refresh]);

  const signedIn = auth.status === 'authed';
  return (
    <main id="main" className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-3"><LogoMark className="h-10 w-10" /><p className="text-lg font-semibold">SubCycle</p></div>
      <div className="rounded-card border border-line bg-surface p-6">
        <h1 className="text-2xl">Verify your email</h1>
        <div className="mt-4 space-y-4 text-sm" aria-live="polite">
          {state.kind === 'checking' ? <p className="flex items-center gap-2 text-muted"><Spinner className="h-4 w-4" />Checking your link…</p> : null}
          {state.kind === 'done' ? (
            <>
              <p role="status"><strong>Your email address is verified.</strong> You can now turn on email reminders.</p>
              <LinkButton to={signedIn ? '/reminders' : '/login'} variant="primary">{signedIn ? 'Go to reminder settings' : 'Sign in'}</LinkButton>
            </>
          ) : null}
          {state.kind === 'invalid' ? (
            <>
              <p role="alert">This verification link is invalid or has expired. Links work once and last 24 hours.</p>
              <LinkButton to={signedIn ? '/reminders' : '/login'} variant="primary">{signedIn ? 'Request a new link' : 'Sign in to request a new link'}</LinkButton>
            </>
          ) : null}
          {state.kind === 'missing' ? <p role="alert">This page needs the link from your verification email. <Link to="/">Go to SubCycle</Link></p> : null}
          {state.kind === 'error' ? <p role="alert">{state.message}</p> : null}
        </div>
      </div>
    </main>
  );
}
