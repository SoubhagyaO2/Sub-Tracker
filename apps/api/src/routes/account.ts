import { Router } from 'express';
import { verifyEmailConfirmSchema } from '@subcycle/shared';
import { generateToken, hashToken } from '../auth/tokens.js';
import { withTransaction } from '../db/pool.js';
import type { AppDeps } from '../deps.js';
import { AppError, conflict } from '../errors.js';
import { authIpLimiter } from '../middleware/rateLimit.js';
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

  return router;
}
