import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';

/**
 * Minimal server-state layer. Any successful mutation calls invalidate(), which bumps a version that every
 * useApi() depends on, so all affected views (dashboard, list, detail, payments, history) refetch together.
 */
interface DataContextValue {
  version: number;
  invalidate: () => void;
}
const DataContext = createContext<DataContextValue>({ version: 0, invalidate: () => undefined });

export function DataProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const invalidate = useCallback(() => setVersion((v) => v + 1), []);
  const value = useMemo(() => ({ version, invalidate }), [version, invalidate]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export const useInvalidate = () => useContext(DataContext).invalidate;

export type ApiState<T> =
  | { status: 'idle' }
  | { status: 'loading'; data?: undefined; refreshing: false }
  | { status: 'ready'; data: T; refreshing: boolean }
  | { status: 'error'; error: ApiError };

const toApiError = (err: unknown): ApiError =>
  err instanceof ApiError ? err : new ApiError(0, 'UNEXPECTED', 'Something unexpected went wrong. Please try again.');

/**
 * Loads data and reloads when `deps`, a mutation (invalidate), or retry() changes.
 * Keeps showing the previous data while refreshing, so lists don't flash empty between filter changes.
 */
export function useApi<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  opts: { enabled?: boolean } = {},
): ApiState<T> & { retry: () => void } {
  const { version } = useContext(DataContext);
  const [state, setState] = useState<ApiState<T>>({ status: 'loading', refreshing: false });
  const [attempt, setAttempt] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const enabled = opts.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setState((s) => (s.status === 'ready' ? { ...s, refreshing: true } : { status: 'loading', refreshing: false }));
    fetcherRef
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data, refreshing: false });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err as { name?: string }).name === 'AbortError') return;
        setState({ status: 'error', error: toApiError(err) });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, attempt, enabled, ...deps]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}
