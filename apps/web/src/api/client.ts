export interface ApiErrorDetail {
  path: string;
  message: string;
}

/** Every failure the UI has to handle, in one shape (see the error envelope in docs/SPEC.md §6.1). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ApiErrorDetail[] = [],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** True when the server could not be reached at all. */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

type QueryValue = string | number | boolean | readonly string[] | undefined | null;
export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  /** Auth endpoints handle their own 401s; everything else treats a 401 as "session ended". */
  skipAuthRedirect?: boolean;
}
export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(','));
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

const FALLBACK_MESSAGE: Record<number, string> = {
  401: 'Your session has ended. Please sign in again.',
  403: 'That request was rejected. Please reload the page and try again.',
  404: 'We couldn’t find that.',
  413: 'That request is too large.',
  429: 'Too many requests. Please wait a moment and try again.',
};

/**
 * The single place HTTP happens. Authentication is the httpOnly session cookie (never readable by this
 * code and never stored by it); state-changing requests carry the CSRF header the server requires.
 */
export async function request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      credentials: 'same-origin',
      signal: opts.signal,
      headers: {
        Accept: 'application/json',
        'X-SubCycle-Client': 'web',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Can’t reach SubCycle. Check your connection and try again.');
  }

  const requestId = res.headers.get('X-Request-Id') ?? undefined;
  if (res.status === 204) return { data: undefined as T };

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON body: handled below */
  }

  if (!res.ok) {
    if (res.status === 401 && !opts.skipAuthRedirect) onUnauthenticated?.();
    const env = (payload as { error?: { code?: string; message?: string; details?: ApiErrorDetail[] } } | null)?.error;
    const message =
      env?.message ?? FALLBACK_MESSAGE[res.status] ?? (res.status >= 500 ? 'Something went wrong on our side. Please try again.' : 'The request failed.');
    throw new ApiError(res.status, env?.code ?? 'REQUEST_FAILED', message, Array.isArray(env?.details) ? env.details : [], requestId);
  }

  const body = payload as { data?: T; meta?: Record<string, unknown> } | null;
  if (body === null || typeof body !== 'object' || !('data' in body)) {
    throw new ApiError(res.status, 'BAD_RESPONSE', 'SubCycle sent a response this page couldn’t read. Please try again.', [], requestId);
  }
  return { data: body.data as T, meta: body.meta };
}
