import { randomBytes } from 'node:crypto';
import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { EMAIL_DOMAIN, EMAIL_PREFIX, db, deleteTestUsers } from './env';

export { expect };
export const PASSWORD = 'Tr0ub4dor&3-horse';
export const NEW_PASSWORD = 'Correct-Horse-9-battery';

// ───────────── dates (the browser context runs in UTC, so "today" is the UTC date) ─────────────
export const ymd = (offsetDays = 0, from = new Date()): string => {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + offsetDays));
  return d.toISOString().slice(0, 10);
};

// ───────────── API helper bound to a page's cookie jar ─────────────
export interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}
export interface Api {
  get(path: string): Promise<ApiResult>;
  post(path: string, data?: unknown): Promise<ApiResult>;
  patch(path: string, data?: unknown): Promise<ApiResult>;
  del(path: string, data?: unknown): Promise<ApiResult>;
}
const CSRF = { 'X-SubCycle-Client': 'web' };
export function apiFor(request: APIRequestContext): Api {
  const wrap = async (res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<ApiResult> => ({ status: res.status(), body: await res.json().catch(() => null) });
  return {
    get: async (p) => wrap(await request.get(p)),
    post: async (p, data) => wrap(await request.post(p, { headers: CSRF, data })),
    patch: async (p, data) => wrap(await request.patch(p, { headers: CSRF, data })),
    del: async (p, data) => wrap(await request.delete(p, { headers: CSRF, data })),
  };
}

export interface Account {
  email: string;
  name: string;
  password: string;
  id: string;
}

export interface SubInput {
  name: string;
  amountMinor: number;
  billingFrequency?: string;
  nextBillingDate?: string;
  currency?: string;
  category?: string;
  status?: string;
  trialEndDate?: string;
  reminderLeadDays?: number;
}

interface Fixtures {
  /** Automatic: fails any test during which the page broke the Content-Security-Policy or threw an uncaught error. */
  pageGuard: void;
  /** Registers a throwaway user through the API; the page's context becomes signed in as them. Deleted after the test, pass or fail. */
  signUp: (opts?: { name?: string; password?: string }) => Promise<Account>;
  api: Api;
  /** Creates a subscription through the API. */
  addSub: (input: SubInput) => Promise<{ id: string; name: string }>;
}

const octet = () => randomBytes(1)[0]!;
const randomIp = () => `10.${octet()}.${octet()}.${(octet() % 250) + 1}`;

export const test = base.extend<Fixtures>({
  pageGuard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error' && /Content Security Policy|Refused to (load|apply|execute|connect)/i.test(m.text())) problems.push(`CSP: ${m.text().slice(0, 200)}`);
      });
      page.on('pageerror', (e) => problems.push(`uncaught error: ${e.name}`));
      await use();
      expect(problems, 'the page violated the CSP or threw').toEqual([]);
    },
    { auto: true },
  ],

  // Each test presents its own client IP (the API trusts one proxy hop), so per-IP rate limits never couple tests.
  context: async ({ browser, contextOptions }, use) => {
    const ctx = await browser.newContext({ ...contextOptions, extraHTTPHeaders: { 'X-Forwarded-For': randomIp() } });
    await use(ctx);
    await ctx.close();
  },

  api: async ({ context }, use) => {
    await use(apiFor(context.request));
  },

  signUp: async ({ api }, use) => {
    const created: string[] = [];
    try {
      await use(async (opts = {}) => {
        const email = `${EMAIL_PREFIX}${randomBytes(6).toString('hex')}${EMAIL_DOMAIN}`;
        const name = opts.name ?? 'Eve E2E';
        const password = opts.password ?? PASSWORD;
        created.push(email); // registered for cleanup BEFORE the request, so a failure part-way still cleans up
        const res = await api.post('/api/auth/register', { email, password, displayName: name, timezone: 'UTC' });
        if (res.status !== 201) throw new Error(`register failed with HTTP ${res.status}`);
        return { email, name, password, id: res.body.data.user.id as string };
      });
    } finally {
      if (created.length) await deleteTestUsers(created); // runs when the test fails or times out too
    }
  },

  addSub: async ({ api }, use) => {
    await use(async (input) => {
      const res = await api.post('/api/subscriptions', { billingFrequency: 'monthly', category: 'video', nextBillingDate: ymd(10), ...input });
      if (res.status !== 201) throw new Error(`createSub failed: HTTP ${res.status} ${JSON.stringify(res.body?.error?.details ?? res.body?.error?.code)}`);
      return { id: res.body.data.id as string, name: res.body.data.name as string };
    });
  },
});

// ───────────── database helpers for scenarios the UI cannot create (always scoped to the test's own user) ─────────────
const count = async (sql: string, id: string) => Number((await db().query(sql, [id])).rows[0].n);
export const sessionsOf = (userId: string) => count('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', userId);
export const paymentCount = (userId: string) => count('SELECT count(*)::int AS n FROM payments WHERE user_id = $1', userId);
export const userExists = async (userId: string) => (await count('SELECT count(*)::int AS n FROM users WHERE id = $1', userId)) === 1;
export const revokeSessions = (userId: string) => db().query('DELETE FROM sessions WHERE user_id = $1', [userId]);
export const expireSessions = (userId: string) => db().query("UPDATE sessions SET idle_expires_at = now() - interval '1 minute' WHERE user_id = $1", [userId]);

export async function fillSignIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
export async function signInWithUi(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await fillSignIn(page, email, password);
}

export async function openAccountMenu(page: Page): Promise<void> {
  // The sidebar (desktop) has its own Sign out; the account menu is the header control used on small screens.
  await page.getByRole('button', { name: /Account menu/ }).click();
}
