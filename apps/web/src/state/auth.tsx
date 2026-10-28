import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LoginInput, PreferencesDto, RegisterInput, SessionPayload, UserDto } from '@subcycle/shared';
import { ApiError, setUnauthenticatedHandler } from '../api/client';
import { authApi } from '../api/endpoints';
import { browserTimeZone } from '../lib/dates';

/**
 * Authentication state. The session itself is an httpOnly cookie set and read by the server only:
 * this code never sees a token and never writes anything to localStorage/sessionStorage.
 */
export type AuthState =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError }
  | { status: 'anon'; notice?: string }
  | { status: 'authed'; user: UserDto; preferences: PreferencesDto; features: SessionPayload['features'] };

interface AuthContextValue {
  state: AuthState;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
  /** Re-reads the session (e.g. after verifying an email address). Quiet: never shows the loading screen. */
  refresh: () => Promise<void>;
  /** Replaces the preferences held in memory after a successful save. */
  setPreferences: (p: PreferencesDto) => void;
  /** Replaces the user held in memory after a profile save. */
  setUser: (u: UserDto) => void;
  /** Leaves the signed-in state WITHOUT any request (the server session is already gone, e.g. after account deletion). */
  endSessionLocally: (notice?: string) => void;
}
const AuthContext = createContext<AuthContextValue | null>(null);

export const ACCOUNT_DELETED_NOTICE = 'Your account and its data have been permanently deleted.';
export const SESSION_ENDED_NOTICE = 'Your session has ended. Please sign in again.';

const authed = (p: SessionPayload): AuthState => ({ status: 'authed', user: p.user, preferences: p.preferences, features: p.features });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    authApi
      .me(controller.signal)
      .then((p) => !controller.signal.aborted && setState(authed(p)))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) setState({ status: 'anon' });
        else setState({ status: 'error', error: err instanceof ApiError ? err : new ApiError(0, 'UNEXPECTED', 'Something unexpected went wrong.') });
      });
    return () => controller.abort();
  }, [attempt]);

  // Any API call that comes back 401 while signed in means the session ended (expired or revoked).
  useEffect(() => {
    setUnauthenticatedHandler(() => setState((s) => (s.status === 'authed' ? { status: 'anon', notice: SESSION_ENDED_NOTICE } : s)));
    return () => setUnauthenticatedHandler(null);
  }, []);

  const login = useCallback(async (input: LoginInput) => setState(authed(await authApi.login(input))), []);
  const register = useCallback(async (input: RegisterInput) => {
    setState(authed(await authApi.register({ ...input, timezone: input.timezone ?? browserTimeZone() })));
  }, []);
  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* Signing out must never fail from the user's side: the server session expires on its own. */
    }
    setState({ status: 'anon' }); // whatever the server said, this browser is signed out
  }, []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const refresh = useCallback(async () => {
    try {
      setState(authed(await authApi.me()));
    } catch {
      /* keep what we have: a failed refresh must not sign anyone out */
    }
  }, []);
  const setPreferences = useCallback((preferences: PreferencesDto) => setState((s) => (s.status === 'authed' ? { ...s, preferences } : s)), []);

  const setUser = useCallback((user: UserDto) => setState((s) => (s.status === 'authed' ? { ...s, user } : s)), []);
  const endSessionLocally = useCallback((notice?: string) => setState({ status: 'anon', notice }), []);

  const value = useMemo(
    () => ({ state, login, register, logout, retry, refresh, setPreferences, setUser, endSessionLocally }),
    [state, login, register, logout, retry, refresh, setPreferences, setUser, endSessionLocally],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** For components that only render when signed in. */
export function useSession(): Extract<AuthState, { status: 'authed' }> {
  const { state } = useAuth();
  if (state.status !== 'authed') throw new Error('useSession used while signed out');
  return state;
}
