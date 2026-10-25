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
}
const AuthContext = createContext<AuthContextValue | null>(null);

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

  const value = useMemo(() => ({ state, login, register, logout, retry }), [state, login, register, logout, retry]);
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

/** Applies the saved theme preference (dark / light / system) to the document. */
export function useApplyTheme(theme: PreferencesDto['theme'] | undefined): void {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const resolved = theme === 'light' ? 'light' : theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : 'dark';
      root.dataset.theme = resolved;
    };
    apply();
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}
