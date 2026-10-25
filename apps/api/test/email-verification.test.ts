import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CSRF, DAY, FakeMailer, createCtx, me, registerUser, resetDb } from './helpers.js';

const MIN = 60_000;

const post = (app: import('express').Express, path: string, cookie?: string, body?: object) => {
  const r = request(app).post(path).set(CSRF);
  if (cookie) r.set('Cookie', cookie);
  return body ? r.send(body) : r;
};
const SEND = '/api/account/email-verification';
const CONFIRM = '/api/account/email-verification/confirm';
const tokenFrom = (mail: { text: string }) => /verify-email\?token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;

describe('when SMTP is NOT configured', () => {
  const ctx = createCtx();
  beforeEach(() => resetDb(ctx.pool));
  afterAll(() => ctx.pool.end());

  it('reports email as unavailable and never claims anything was sent', async () => {
    const { cookie, res: reg } = await registerUser(ctx.app);
    expect(reg.body.data.features.emailVerificationAvailable).toBe(false);

    const res = await post(ctx.app, SEND, cookie);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('EMAIL_NOT_CONFIGURED');
    expect(JSON.stringify(res.body)).not.toMatch(/"sent"\s*:\s*true/);

    // No token was created, and the account still works and is simply unverified.
    expect((await ctx.pool.query('SELECT count(*)::int n FROM email_verification_tokens')).rows[0].n).toBe(0);
    const profile = await me(ctx.app, cookie);
    expect(profile.status).toBe(200);
    expect(profile.body.data.user.emailVerified).toBe(false);
    expect(profile.body.data.features.emailVerificationAvailable).toBe(false);
  });

  it('still requires authentication', async () => {
    expect((await post(ctx.app, SEND)).status).toBe(401);
  });

  it('does not let a client mark itself verified', async () => {
    const { cookie } = await registerUser(ctx.app);
    const res = await post(ctx.app, CONFIRM, cookie, { token: 'x'.repeat(43) });
    expect(res.status).toBe(400);
    expect((await me(ctx.app, cookie)).body.data.user.emailVerified).toBe(false);
  });
});

describe('when SMTP is configured', () => {
  const mailer = new FakeMailer();
  const ctx = createCtx({ mailer });
  const { app, pool, clock } = ctx;
  beforeEach(async () => {
    await resetDb(pool);
    mailer.sent = [];
    mailer.failNext = false;
    clock.set('2030-01-15T10:00:00.000Z');
  });
  afterAll(() => pool.end());

  it('sends exactly one email to the account address and stores only a token hash', async () => {
    const { cookie, email, res: reg } = await registerUser(app);
    expect(reg.body.data.features.emailVerificationAvailable).toBe(true);

    const res = await post(app, SEND, cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: true });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(email);

    const token = tokenFrom(mailer.sent[0]!);
    const { rows } = await pool.query('SELECT token_hash, expires_at FROM email_verification_tokens');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash.equals(createHash('sha256').update(token).digest())).toBe(true);
    expect(rows[0].token_hash.toString('utf8')).not.toContain(token);
    expect(rows[0].expires_at.getTime()).toBe(clock.now().getTime() + DAY);
  });

  it('confirms with the emailed token, then rejects reuse', async () => {
    const { cookie } = await registerUser(app);
    await post(app, SEND, cookie);
    const token = tokenFrom(mailer.sent[0]!);

    const ok = await post(app, CONFIRM, undefined, { token }); // no session needed: the token is the credential
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ verified: true });
    expect((await me(app, cookie)).body.data.user.emailVerified).toBe(true);

    const reuse = await post(app, CONFIRM, undefined, { token });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('INVALID_TOKEN');
  });

  it('only verifies the user the token was issued to', async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await post(app, SEND, a.cookie);
    await post(app, CONFIRM, undefined, { token: tokenFrom(mailer.sent[0]!) });
    expect((await me(app, a.cookie)).body.data.user.emailVerified).toBe(true);
    expect((await me(app, b.cookie)).body.data.user.emailVerified).toBe(false);
  });

  it('rejects an expired token (24h TTL, exact boundary) and a made-up token', async () => {
    const { cookie } = await registerUser(app);
    await post(app, SEND, cookie);
    const token = tokenFrom(mailer.sent[0]!);

    clock.advance(DAY); // expires_at > now is required, so exactly 24h is already expired
    const expired = await post(app, CONFIRM, undefined, { token });
    expect(expired.status).toBe(400);
    expect((await me(app, cookie)).body.data.user.emailVerified).toBe(false);

    expect((await post(app, CONFIRM, undefined, { token: 'A'.repeat(43) })).status).toBe(400);
    expect((await post(app, CONFIRM, undefined, { token: 'short' })).status).toBe(422);
  });

  it('accepts a token 1ms before expiry', async () => {
    const { cookie } = await registerUser(app);
    await post(app, SEND, cookie);
    clock.advance(DAY - 1);
    expect((await post(app, CONFIRM, undefined, { token: tokenFrom(mailer.sent[0]!) })).status).toBe(200);
  });

  it('enforces a resend cooldown and invalidates the previous token on resend', async () => {
    const { cookie } = await registerUser(app);
    await post(app, SEND, cookie).expect(200);
    const first = tokenFrom(mailer.sent[0]!);

    clock.advance(59_000);
    const tooSoon = await post(app, SEND, cookie);
    expect(tooSoon.status).toBe(429);
    expect(mailer.sent).toHaveLength(1);

    clock.advance(1000);
    await post(app, SEND, cookie).expect(200);
    expect(mailer.sent).toHaveLength(2);
    expect((await post(app, CONFIRM, undefined, { token: first })).status).toBe(400); // superseded
    expect((await post(app, CONFIRM, undefined, { token: tokenFrom(mailer.sent[1]!) })).status).toBe(200);
  });

  it('refuses when already verified', async () => {
    const { cookie } = await registerUser(app);
    await post(app, SEND, cookie);
    await post(app, CONFIRM, undefined, { token: tokenFrom(mailer.sent[0]!) });
    clock.advance(2 * MIN);
    const res = await post(app, SEND, cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_VERIFIED');
  });

  it('reports a delivery failure honestly (502), clears the token, and does not claim it was sent', async () => {
    const { cookie } = await registerUser(app);
    mailer.failNext = true;
    const res = await post(app, SEND, cookie);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('EMAIL_SEND_FAILED');
    expect(JSON.stringify(res.body)).not.toMatch(/refused|SMTP/); // provider details are not leaked
    expect(mailer.sent).toHaveLength(0);
    expect((await pool.query('SELECT count(*)::int n FROM email_verification_tokens')).rows[0].n).toBe(0);

    // The failed attempt does not trigger the cooldown, so the user can retry immediately.
    await post(app, SEND, cookie).expect(200);
    expect(mailer.sent).toHaveLength(1);
  });

  it('rejects a token issued for an address the account no longer has', async () => {
    const { cookie } = await registerUser(app);
    await post(app, SEND, cookie);
    await pool.query("UPDATE users SET email = 'changed@example.com'");
    expect((await post(app, CONFIRM, undefined, { token: tokenFrom(mailer.sent[0]!) })).status).toBe(400);
    expect((await pool.query('SELECT email_verified_at FROM users')).rows[0].email_verified_at).toBeNull();
  });

  it('requires the CSRF header on both endpoints', async () => {
    const { cookie } = await registerUser(app);
    expect((await request(app).post(SEND).set('Cookie', cookie)).status).toBe(403);
    expect((await request(app).post(CONFIRM).send({ token: 'A'.repeat(43) })).status).toBe(403);
  });
});
