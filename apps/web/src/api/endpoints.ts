import type {
  AnalyticsBucket,
  AnalyticsResponse,
  CalendarOccurrence,
  CalendarResponseMeta,
  CreatePaymentInput,
  CreateSubscriptionInput,
  LoginInput,
  PaymentDto,
  PreferencesDto,
  PriceChangeDto,
  ReminderChannel,
  ReminderDto,
  ReminderStatus,
  UpdateReminderPreferencesInput,
  RegisterInput,
  SessionPayload,
  StatusActionInput,
  SubscriptionDto,
  UpdateSubscriptionInput,
  CurrencyCode,
  DateOnly,
} from '@subcycle/shared';
import { request } from './client';

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
}
export interface Paged<T> {
  items: T[];
  meta: PageMeta;
}

const toPaged = <T>(r: { data: T[]; meta?: Record<string, unknown> }): Paged<T> => ({ items: r.data, meta: r.meta as unknown as PageMeta });

/** Exactly the query parameters documented for GET /api/subscriptions. */
export interface SubscriptionListParams {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: readonly string[];
  category?: readonly string[];
  frequency?: readonly string[];
  currency?: string;
  minPrice?: number;
  maxPrice?: number;
  renewsWithinDays?: number;
  sort?: 'name' | 'nextRenewal' | 'price' | 'created';
  order?: 'asc' | 'desc';
}

export interface PaymentResult {
  payment: PaymentDto;
  subscription: SubscriptionDto;
  nextBillingDateAdvanced: boolean;
}

export interface UpcomingOccurrence {
  date: DateOnly;
  amountMinor: number;
  currency: CurrencyCode;
}

export const authApi = {
  me: (signal?: AbortSignal) => request<SessionPayload>('GET', '/api/auth/me', { signal, skipAuthRedirect: true }).then((r) => r.data),
  login: (input: LoginInput) => request<SessionPayload>('POST', '/api/auth/login', { body: input, skipAuthRedirect: true }).then((r) => r.data),
  register: (input: RegisterInput) => request<SessionPayload>('POST', '/api/auth/register', { body: input, skipAuthRedirect: true }).then((r) => r.data),
  logout: () => request<void>('POST', '/api/auth/logout', { skipAuthRedirect: true }).then(() => undefined),
};

export const subscriptionsApi = {
  list: (params: SubscriptionListParams, signal?: AbortSignal) =>
    request<SubscriptionDto[]>('GET', '/api/subscriptions', { query: { ...params }, signal }).then(toPaged),
  get: (id: string, signal?: AbortSignal) => request<SubscriptionDto>('GET', `/api/subscriptions/${id}`, { signal }).then((r) => r.data),
  create: (body: CreateSubscriptionInput) => request<SubscriptionDto>('POST', '/api/subscriptions', { body }).then((r) => r.data),
  update: (id: string, body: UpdateSubscriptionInput) => request<SubscriptionDto>('PATCH', `/api/subscriptions/${id}`, { body }).then((r) => r.data),
  remove: (id: string) => request<void>('DELETE', `/api/subscriptions/${id}`).then(() => undefined),
  transition: (id: string, body: StatusActionInput) => request<SubscriptionDto>('POST', `/api/subscriptions/${id}/status`, { body }).then((r) => r.data),
  upcoming: (id: string, count: number, signal?: AbortSignal) =>
    request<UpcomingOccurrence[]>('GET', `/api/subscriptions/${id}/upcoming`, { query: { count }, signal }).then((r) => r.data),
};

export const paymentsApi = {
  list: (subscriptionId: string, page: { page?: number; pageSize?: number }, signal?: AbortSignal) =>
    request<PaymentDto[]>('GET', `/api/subscriptions/${subscriptionId}/payments`, { query: { ...page }, signal }).then(toPaged),
  create: (subscriptionId: string, body: CreatePaymentInput) =>
    request<PaymentResult>('POST', `/api/subscriptions/${subscriptionId}/payments`, { body }).then((r) => r.data),
  remove: (subscriptionId: string, paymentId: string) =>
    request<void>('DELETE', `/api/subscriptions/${subscriptionId}/payments/${paymentId}`).then(() => undefined),
};

export const priceHistoryApi = {
  list: (subscriptionId: string, page: { page?: number; pageSize?: number }, signal?: AbortSignal) =>
    request<PriceChangeDto[]>('GET', `/api/subscriptions/${subscriptionId}/price-history`, { query: { ...page }, signal }).then(toPaged),
};

/** Every subscription (all statuses, newest first) by walking the pages. The server caps a user at 500. */
export async function fetchAllSubscriptions(signal?: AbortSignal): Promise<SubscriptionDto[]> {
  const all: SubscriptionDto[] = [];
  for (let page = 1; page <= 10; page++) {
    const { items, meta } = await subscriptionsApi.list(
      { page, pageSize: 100, status: ['active', 'trial', 'paused', 'cancelled', 'archived'], sort: 'created', order: 'desc' },
      signal,
    );
    all.push(...items);
    if (all.length >= meta.total || items.length === 0) break;
  }
  return all;
}

// ───────────── Stage 7: calendar, analytics, reminders, reminder settings ─────────────

export const calendarApi = {
  renewals: (q: { from?: DateOnly; to?: DateOnly }, signal?: AbortSignal) =>
    request<CalendarOccurrence[]>('GET', '/api/calendar/renewals', { query: { ...q }, signal }).then((r) => ({
      items: r.data,
      meta: r.meta as unknown as CalendarResponseMeta,
    })),
};

export const analyticsApi = {
  spending: (q: { from?: DateOnly; to?: DateOnly; bucket?: AnalyticsBucket }, signal?: AbortSignal) =>
    request<AnalyticsResponse>('GET', '/api/analytics/spending', { query: { ...q }, signal }).then((r) => r.data),
};

export interface ReminderMeta extends PageMeta {
  /** Delivered in-app reminders the user has not dismissed yet. */
  unread: number;
}
export interface ReminderListParams {
  page?: number;
  pageSize?: number;
  channel?: ReminderChannel;
  status?: readonly ReminderStatus[];
  unread?: boolean;
}

export const remindersApi = {
  list: (q: ReminderListParams, signal?: AbortSignal) =>
    request<ReminderDto[]>('GET', '/api/reminders', { query: { ...q, unread: q.unread ? 'true' : undefined }, signal }).then((r) => ({
      items: r.data,
      meta: r.meta as unknown as ReminderMeta,
    })),
  dismiss: (id: string) => request<ReminderDto>('POST', `/api/reminders/${id}/dismiss`).then((r) => r.data),
};

export const preferencesApi = {
  get: (signal?: AbortSignal) => request<PreferencesDto>('GET', '/api/preferences', { signal }).then((r) => r.data),
  update: (patch: UpdateReminderPreferencesInput) => request<PreferencesDto>('PATCH', '/api/preferences', { body: patch }).then((r) => r.data),
};

export const accountApi = {
  /** 503 when the server has no email provider; 429 within the resend cooldown; 409 if already verified. */
  sendVerification: () => request<{ sent: boolean }>('POST', '/api/account/email-verification').then((r) => r.data),
  /** The emailed token is the credential, so this works without a session. */
  confirmVerification: (token: string) =>
    request<{ verified: boolean }>('POST', '/api/account/email-verification/confirm', { body: { token }, skipAuthRedirect: true }).then((r) => r.data),
};
