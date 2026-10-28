import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PASSWORD, captureLogs, createCtx, registerUser } from './helpers.js';

const captured = captureLogs();
const ctx = createCtx({ logger: captured.logger });
afterAll(() => ctx.pool.end());

/** The verification token travels in the browser URL (/verify-email?token=...) and in a POST body, never in an API URL: even if one
 *  ever did reach an API URL's query string, the API's own logs must not contain it. */
describe('request logging keeps query strings and bodies out of the logs', () => {
  it('logs the path only, for every status class', async () => {
    const SECRET = 'verification-token-should-never-be-logged-0123456789';
    await request(ctx.app).get(`/api/health?token=${SECRET}`);
    await request(ctx.app).get(`/api/subscriptions?token=${SECRET}&q=${SECRET}`); // 401
    await request(ctx.app).get(`/api/does-not-exist?token=${SECRET}`); // 404
    const reg = await registerUser(ctx.app);
    await request(ctx.app).get(`/api/calendar/renewals?from=${SECRET}`).set('Cookie', reg.cookie); // 422
    await request(ctx.app).post('/api/account/email-verification/confirm').set('X-SubCycle-Client', 'web').send({ token: SECRET }); // body
    await request(ctx.app).post('/api/auth/login').set('X-SubCycle-Client', 'web').send({ email: reg.email, password: PASSWORD });
    const text = captured.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(reg.cookie.split('=')[1]!);
    expect(captured.events().some((e) => (e.req as { url?: string } | undefined)?.url === '/api/health')).toBe(true); // the path itself is logged
  });
});
