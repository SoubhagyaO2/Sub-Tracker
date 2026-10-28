import { Router } from 'express';
import { changePasswordSchema, deleteAccountSchema, updateAccountSchema, verifyEmailConfirmSchema } from '@subcycle/shared';
import { toUserDto } from '../auth/dto.js';
import { assertPasswordAcceptable, hashPassword, verifyPassword } from '../auth/password.js';
import { createSession } from '../auth/sessions.js';
import { clearSessionCookie, setSessionCookie } from '../middleware/cookies.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import { withTransaction } from '../db/pool.js';
import type { AppDeps } from '../deps.js';
import { AppError, conflict, validation } from '../errors.js';
import { authIpLimiter, passwordConfirmLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/session.js';

export function accountRouter(deps: AppDeps): Router {
  const { config, pool, clock, mailer } = deps;
  const router = Router();
  const ipLimit = authIpLimiter(config.rateLimit.authWindowMs, config.rateLimit.authMax);

  /**
   * Sends a verification email. Without an SMTP provider this fails honestly with 503:
   * no token is created and nothing is claimed as sent.
   */
  router.post('/email-verification', requireAuth, ipLimit, async (req, res) => {
    const auth = req.auth!;
    if (!mailer.configured) {
      throw new AppError(
        503,
        'EMAIL_NOT_CONFIGURED',
        "Email isn't configured on this server, so verification emails can't be sent.",
      );
    }
    if (auth.emailVerifiedAt) throw conflict('ALREADY_VERIFIED', 'Your email is already verified.');

    const now = clock.now();
    const last = await pool.query<{ created_at: Date }>(
      'SELECT max(created_at) AS created_at FROM email_verification_tokens WHERE user_id = $1 AND email = $2',
      [auth.userId, auth.email],
    );
    const lastAt = last.rows[0]?.created_at;
    if (lastAt && now.getTime() - lastAt.getTime() < config.emailVerification.resendCooldownMs) {
      throw new AppError(429, 'RATE_LIMITED', 'A verification email was just sent. Please wait a minute before requesting another.');
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    await withTransaction(pool, async (tx) => {
      await tx.query('DELETE FROM email_verification_tokens WHERE user_id = $1 AND used_at IS NULL', [auth.userId]);
      await tx.query(
        'INSERT INTO email_verification_tokens (user_id, email, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)',
        [auth.userId, auth.email, tokenHash, new Date(now.getTime() + config.emailVerification.tokenTtlMs), now],
      );
    });

    try {
      await mailer.send({
        to: auth.email,
        subject: 'Verify your SubCycle email',
        text: `Hi ${auth.displayName},\n\nConfirm your email address for SubCycle by opening this link:\n${config.appUrl}/verify-email?token=${token}\n\nThe link expires in 24 hours. If you did not create a SubCycle account, ignore this message.\n`,
      });
    } catch (err) {
      await pool.query('DELETE FROM email_verification_tokens WHERE token_hash = $1', [tokenHash]);
      req.log?.warn({ err }, 'verification email delivery failed');
      throw new AppError(502, 'EMAIL_SEND_FAILED', "We couldn't send the verification email. Please try again later.");
    }
    res.json({ data: { sent: true } });
  });

  /** The token is the credential (it was mailed to the address), so no session is required. */
  router.post('/email-verification/confirm', ipLimit, async (req, res) => {
    const { token } = verifyEmailConfirmSchema.parse(req.body ?? {});
    const now = clock.now();
    const ok = await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ id: string; user_id: string; email: string; user_email: string }>(
        `SELECT t.id, t.user_id, t.email, u.email AS user_email
           FROM email_verification_tokens t
           JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > $2
          FOR UPDATE OF t`,
        [hashToken(token), now],
      );
      const row = rows[0];
      // The address verified must still be the account's address.
      if (!row || row.email !== row.user_email) return false;
      await tx.query('UPDATE email_verification_tokens SET used_at = $2 WHERE id = $1', [row.id, now]);
      await tx.query('UPDATE users SET email_verified_at = $2 WHERE id = $1 AND email_verified_at IS NULL', [row.user_id, now]);
      return true;
    });
    if (!ok) throw new AppError(400, 'INVALID_TOKEN', 'This verification link is invalid or has expired.');
    res.json({ data: { verified: true } });
  });

  const confirmLimit = passwordConfirmLimiter(config.rateLimit.authWindowMs, config.rateLimit.loginPerEmailMax);

  async function storedHash(userId: string): Promise<string> {
    const { rows } = await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!rows[0]) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required.');
    return rows[0].password_hash;
  }

  /** Profile details. The email address cannot be changed in v1 (it would invalidate verification and sign-in). */
  router.patch('/', requireAuth, async (req, res) => {
    const auth = req.auth!;
    const { displayName } = updateAccountSchema.parse(req.body ?? {});
    await pool.query('UPDATE users SET display_name = $2, updated_at = $3 WHERE id = $1', [auth.userId, displayName, clock.now()]);
    res.json({ data: { user: toUserDto({ id: auth.userId, email: auth.email, displayName, emailVerifiedAt: auth.emailVerifiedAt }) } });
  });

  /**
   * Changes the password. The caller is already authenticated, so a wrong current password is a field error (422),
   * never a 401 (which the web app reads as "session ended") and never anything about other accounts.
   * Session handling, decided explicitly: EVERY session of the user is deleted, including the current one, and a fresh
   * session is issued in the same transaction, so the old cookie can never be replayed (no session fixation) and any
   * other device must sign in again with the new password.
   */
  router.post('/password', requireAuth, confirmLimit, async (req, res) => {
    const auth = req.auth!;
    const input = changePasswordSchema.parse(req.body ?? {});
    const oldHash = await storedHash(auth.userId);
    if (!(await verifyPassword(oldHash, input.currentPassword))) {
      throw validation([{ path: 'currentPassword', message: 'Your current password is incorrect.' }]);
    }
    if (input.newPassword === input.currentPassword) {
      throw validation([{ path: 'newPassword', message: 'Choose a password different from your current one.' }]);
    }
    assertPasswordAcceptable(input.newPassword, auth.email);
    const newHash = await hashPassword(input.newPassword);

    const result = await withTransaction(pool, async (tx) => {
      // Optimistic: only replace the hash we verified. A concurrent change wins and this request is refused.
      const upd = await tx.query('UPDATE users SET password_hash = $2, updated_at = $3 WHERE id = $1 AND password_hash = $4', [auth.userId, newHash, clock.now(), oldHash]);
      if (upd.rowCount !== 1) return null;
      const del = await tx.query('DELETE FROM sessions WHERE user_id = $1', [auth.userId]);
      const session = await createSession(tx, config, clock, auth.userId, req.get('user-agent'));
      return { session, revoked: del.rowCount ?? 0 };
    });
    if (!result) throw conflict('PASSWORD_CHANGED', 'Your password was changed by another request. Please try again.');
    setSessionCookie(res, config, result.session.token, result.session.expiresAt);
    req.log?.info({ event: 'password_changed', userId: auth.userId, sessionsRevoked: result.revoked }, 'password changed');
    res.json({ data: { changed: true, otherSessionsSignedOut: Math.max(0, result.revoked - 1) } });
  });

  /**
   * Permanently deletes the account. Needs the password (re-authentication) and the account's email typed out.
   * One DELETE on `users`: preferences, sessions, subscriptions, payments, price history, reminders and verification
   * tokens go with it through ON DELETE CASCADE, atomically (all or nothing).
   */
  router.delete('/', requireAuth, confirmLimit, async (req, res) => {
    const auth = req.auth!;
    const input = deleteAccountSchema.parse(req.body ?? {});
    if (!(await verifyPassword(await storedHash(auth.userId), input.password))) {
      throw validation([{ path: 'password', message: 'Your password is incorrect.' }]);
    }
    if (input.confirmEmail !== auth.email.toLowerCase()) {
      throw validation([{ path: 'confirmEmail', message: 'That doesn’t match your account email.' }]);
    }
    await withTransaction(pool, async (tx) => {
      await tx.query('DELETE FROM sessions WHERE user_id = $1', [auth.userId]); // explicit; the cascade would do it too
      const del = await tx.query('DELETE FROM users WHERE id = $1', [auth.userId]);
      if (del.rowCount !== 1) throw new AppError(404, 'NOT_FOUND', 'We couldn’t find that.');
    });
    req.log?.info({ event: 'account_deleted', userId: auth.userId }, 'account deleted');
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  return router;
}
