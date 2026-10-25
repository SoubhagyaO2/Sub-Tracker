import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import {
  allowedActions,
  effectiveNextBillingDate,
  monthlyEquivalentMinor,
  type PaymentDto,
  type PriceChangeDto,
  type SessionPayload,
  type SubscriptionDto,
} from '@subcycle/shared';
import { AppRoutes, Providers } from '../src/App';

// ───────────── fixed clock: 2030-01-15 15:30 in Asia/Kolkata ─────────────
export const NOW = '2030-01-15T10:00:00.000Z';
export const TODAY = '2030-01-15';

/** Fakes only Date (not timers), so waitFor/userEvent keep working while "today" stays deterministic. */
export function freezeTime(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
}

// ───────────── fixtures ─────────────
export const SESSION: SessionPayload = {
  user: { id: 'u1', email: 'asha@example.com', displayName: 'Asha Rao', emailVerified: false },
  preferences: {
    currency: 'INR', theme: 'dark', timezone: 'Asia/Kolkata', reminderLeadDays: 3, reminderHour: 9,
    inAppReminders: true, emailRemindersEnabled: false, trialRemindersEnabled: true,
  },
  features: { emailVerificationAvailable: false },
};

let seq = 0;
export function makeSub(over: Partial<SubscriptionDto> = {}): SubscriptionDto {
  const base: SubscriptionDto = {
    id: `s${++seq}`, name: 'Netflix', category: 'video', amountMinor: 64900, currency: 'INR', billingFrequency: 'monthly',
    monthlyEquivalentMinor: 64900, anchorDate: '2030-02-01', nextBillingDate: '2030-02-01', effectiveNextBillingDate: '2030-02-01',
    startDate: '2030-01-01', trialEndDate: null, status: 'active', cancelledOn: null, paymentMethodLabel: null, websiteUrl: null,
    cancellationUrl: null, notes: null, usageLevel: null, reminderLeadDays: null, remindersEnabled: true, icon: null,
    allowedActions: [], createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z',
  };
  const s = { ...base, ...over };
  if (over.monthlyEquivalentMinor === undefined) s.monthlyEquivalentMinor = monthlyEquivalentMinor(s.amountMinor, s.billingFrequency);
  if (over.effectiveNextBillingDate === undefined) s.effectiveNextBillingDate = effectiveNextBillingDate(s, TODAY);
  if (over.allowedActions === undefined) s.allowedActions = allowedActions(s.status);
  return s;
}

export function makePayment(over: Partial<PaymentDto> = {}): PaymentDto {
  return {
    id: `p${++seq}`, subscriptionId: 's1', amountMinor: 64900, currency: 'INR', paidOn: '2030-01-10', status: 'paid',
    forBillingDate: null, note: null, source: 'user_entered', createdAt: '2030-01-10T08:00:00.000Z', ...over,
  };
}

export function makeHistory(over: Partial<PriceChangeDto> = {}): PriceChangeDto {
  return {
    id: `h${++seq}`, subscriptionId: 's1', oldAmountMinor: 59900, newAmountMinor: 64900, currency: 'INR', effectiveOn: '2029-12-01',
    note: null, createdAt: '2029-12-01T08:00:00.000Z', ...over,
  };
}

// ───────────── fake API server ─────────────
export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
  credentials: RequestCredentials | undefined;
}
export interface Reply {
  status?: number;
  body?: unknown;
}
type Handler = (req: RecordedRequest, params: Record<string, string>) => Reply | Promise<Reply>;

export const ok = (data: unknown, meta?: unknown): Reply => ({ body: meta === undefined ? { data } : { data, meta } });
export const page = <T,>(items: T[], total = items.length, p = 1, pageSize = 25): Reply => ok(items, { page: p, pageSize, total });
export const fail = (status: number, code: string, message: string, details?: { path: string; message: string }[]): Reply => ({
  status,
  body: { error: { code, message, ...(details ? { details } : {}) } },
});

export function deferred<T = Reply>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export class FakeServer {
  private routes: { method: string; re: RegExp; keys: string[]; handler: Handler }[] = [];
  calls: RecordedRequest[] = [];

  on(method: string, pattern: string, handler: Handler | Reply): this {
    const keys: string[] = [];
    const re = new RegExp(`^${pattern.replace(/:([A-Za-z]+)/g, (_m, k: string) => (keys.push(k), '([^/]+)'))}$`);
    this.routes.push({ method, re, keys, handler: typeof handler === 'function' ? handler : () => handler });
    return this;
  }

  /** Later registrations win, so a test can override a default route. */
  private find(method: string, path: string) {
    for (let i = this.routes.length - 1; i >= 0; i--) {
      const r = this.routes[i]!;
      const m = r.method === method ? r.re.exec(path) : null;
      if (m) return { r, params: Object.fromEntries(r.keys.map((k, idx) => [k, decodeURIComponent(m[idx + 1]!)])) };
    }
    return null;
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();
    const req: RecordedRequest = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: new Headers(init.headers),
      credentials: init.credentials,
    };
    this.calls.push(req);
    const hit = this.find(method, url.pathname);
    if (!hit) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Unhandled test request ${method} ${url.pathname}` } }), { status: 404 });
    const reply = await hit.r.handler(req, hit.params);
    const status = reply.status ?? (method === 'DELETE' || (method === 'POST' && url.pathname.endsWith('/logout')) ? 204 : 200);
    return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(reply.body ?? {}), { status, headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req-test-1' } });
  };

  install(): this {
    vi.stubGlobal('fetch', this.fetch);
    return this;
  }

  /** Requests matching a method + path, in order. */
  to(method: string, path: string | RegExp): RecordedRequest[] {
    return this.calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)));
  }
  last(method: string, path: string | RegExp): RecordedRequest | undefined {
    return this.to(method, path).at(-1);
  }
}

/** A server where the user is signed in and every list is empty; tests override what they care about. */
export function signedInServer(): FakeServer {
  return new FakeServer()
    .on('GET', '/api/auth/me', ok(SESSION))
    .on('GET', '/api/subscriptions', page([]))
    .install();
}

export function renderApp(route = '/') {
  const user = userEvent.setup();
  const utils = render(
    <Providers>
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    </Providers>,
  );
  return { user, ...utils };
}

export interface DetailInit {
  sub: SubscriptionDto;
  payments?: PaymentDto[];
  history?: PriceChangeDto[];
  upcoming?: { date: string; amountMinor: number; currency: string }[];
}

/** Server with mutable state, so a mutation followed by a refetch shows the new data (as the real API would). */
export function detailServer(init: DetailInit) {
  const state = { sub: init.sub, payments: [...(init.payments ?? [])], history: [...(init.history ?? [])] };
  const paged = <T,>(items: T[], req: { query: URLSearchParams }) => {
    const p = Number(req.query.get('page') ?? 1);
    const size = Number(req.query.get('pageSize') ?? 25);
    return page(items.slice((p - 1) * size, p * size), items.length, p, size);
  };
  const server = signedInServer()
    .on('GET', '/api/subscriptions/:id', () => ok(state.sub))
    .on('GET', '/api/subscriptions/:id/payments', (req) => paged(state.payments, req))
    .on('GET', '/api/subscriptions/:id/price-history', (req) => paged(state.history, req))
    .on('GET', '/api/subscriptions/:id/upcoming', () => ok(init.upcoming ?? []));
  return { server, state };
}

