import { Router } from 'express';
import { isValidTimeZone, loginSchema, passwordResetConfirmSchema, passwordResetRequestSchema, registerSchema } from '@subcycle/shared';
import { loadPreferences, toUserDto } from '../auth/dto.js';
import { assertPasswordAcceptable, hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from '../auth/password.js';
import { createResetToken, resetLink } from '../auth/passwordReset.js';
import { createSession, deleteSessionById } from '../auth/sessions.js';
import { hashToken } from '../auth/tokens.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import type { AppDeps } from '../deps.js';
import { AppError, conflict, unauthorized } from '../errors.js';
import { clearSessionCookie, setSessionCookie } from '../middleware/cookies.js';
import { authIpLimiter, loginEmailLimiter, resetEmailLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/session.js';

interface LoginRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  email_verified_at: Date | null;
}

export function authRouter(deps: AppDeps): Router {
  const { config, pool, clock, mailer } = deps;
  const router = Router();
  const ipLimit = authIpLimiter(config.rateLimit.authWindowMs, config.rateLimit.authMax);

  router.post('/register', ipLimit, async (req, res) => {
    const input = registerSchema.parse(req.body ?? {});
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', [
        { path: 'timezone', message: 'Unknown time zone.' },
      ]);
    }
    assertPasswordAcceptable(input.password, input.email);
    const passwordHash = await hashPassword(input.password);

    let created;
    try {
      created = await withTransaction(pool, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          'INSERT INTO users (email, password_hash, display_name, created_at, updated_at) VALUES ($1, $2, $3, $4, $4) RETURNING id',
          [input.email, passwordHash, input.displayName, clock.now()],
        );
        const userId = rows[0]!.id;
        await tx.query(
          input.timezone !== undefined
            ? 'INSERT INTO user_preferences (user_id, timezone) VALUES ($1, $2)'
            : 'INSERT INTO user_preferences (user_id) VALUES ($1)',
          input.timezone !== undefined ? [userId, input.timezone] : [userId],
        );
        const session = await createSession(tx, config, clock, userId, req.get('user-agent'));
        return { userId, session, preferences: await loadPreferences(tx, userId) };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('EMAIL_TAKEN', 'An account with this email already exists.');
      }
      throw err;
    }

    // Session rotation: a pre-existing session on this browser is discarded.
    if (req.auth) await deleteSessionById(pool, req.auth.sessionId);
    setSessionCookie(res, config, created.session.token, created.session.expiresAt);
    res.status(201).json({
      data: {
        user: toUserDto({ id: created.userId, email: input.email, displayName: input.displayName, emailVerifiedAt: null }),
        preferences: created.preferences,
        features: { emailVerificationAvailable: mailer.configured },
      },
    });
  });

  router.post('/login', ipLimit, loginEmailLimiter(config.rateLimit.authWindowMs, config.rateLimit.loginPerEmailMax), async (req, res) => {
    const input = loginSchema.parse(req.body ?? {});
    const { rows } = await pool.query<LoginRow>(
      'SELECT id, email, password_hash, display_name, email_verified_at FROM users WHERE lower(email) = $1',
      [input.email],
    );
    const user = rows[0];
    let ok = false;
    if (user) {
      ok = await verifyPassword(user.password_hash, input.password);
    } else {
      await verifyAgainstDummy(input.password);
    }
    if (!user || !ok) throw unauthorized('Incorrect email or password.');

    if (needsRehash(user.password_hash)) {
      await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(input.password)]);
    }

    // Session rotation: always mint a fresh token on login and drop the one presented, if any.
    if (req.auth) await deleteSessionById(pool, req.auth.sessionId);
    const session = await createSession(pool, config, clock, user.id, req.get('user-agent'));
    setSessionCookie(res, config, session.token, session.expiresAt);
    res.json({
      data: {
        user: toUserDto({ id: user.id, email: user.email, displayName: user.display_name, emailVerifiedAt: user.email_verified_at }),
        preferences: await loadPreferences(pool, user.id),
        features: { emailVerificationAvailable: mailer.configured },
      },
    });
  });

  /**
   * Forgot password. Needs email, so without a provider it fails honestly with 503 (the same for every address: nothing about
   * accounts is revealed, and nothing is claimed as sent). With a provider the answer is ALWAYS the same 202, whether or
   * not the address has an account; the email is sent after the response, so timing does not reveal it either.
   */
  router.post('/password-reset/request', ipLimit, resetEmailLimiter(config.rateLimit.authWindowMs, config.rateLimit.resetPerEmailMax), async (req, res) => {
    const { email } = passwordResetRequestSchema.parse(req.body ?? {});
    if (!mailer.configured) {
      throw new AppError(
        503,
        'EMAIL_NOT_CONFIGURED',
        "Password reset by email isn't available on this server. Ask the person who runs SubCycle to reset your password.",
      );
    }
    const { rows } = await pool.query<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE lower(email) = $1', [email]);
    const user = rows[0];
    if (user) {
      const token = await createResetToken(pool, config, clock, user.id);
      const minutes = Math.round(config.passwordReset.tokenTtlMs / 60_000);
      void mailer
        .send({
          to: email,
          subject: 'Reset your SubCycle password',
          text: `Hi ${user.display_name},\n\nSomeone asked to reset the password for your SubCycle account. To choose a new password, open this link:\n${resetLink(config, token)}\n\nThe link works once and expires in ${minutes} minutes. If you did not ask for this, ignore this message: your password has not changed.\n`,
        })
        .catch((err: unknown) => req.log?.warn({ err }, 'password reset email delivery failed'));
    }
    res.status(202).json({ data: { requested: true } });
  });

  /**
   * Sets a new password with the token from the reset link (the token is the credential, so no session is needed).
   * Single use, expires, same password policy as registration. EVERY session of the user is deleted ("sign out everywhere"),
   * all of the user's other reset tokens are removed, and nobody is signed in: the owner signs in with the new password.
   */
  router.post('/password-reset/confirm', ipLimit, async (req, res) => {
    const { token, newPassword } = passwordResetConfirmSchema.parse(req.body ?? {});
    const now = clock.now();
    const done = await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<{ id: string; user_id: string; email: string; display_name: string }>(
        `SELECT t.id, t.user_id, u.email, u.display_name
           FROM password_reset_tokens t
           JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > $2
          FOR UPDATE OF t`,
        [hashToken(token), now],
      );
      const row = rows[0];
      if (!row) return null;
      try {
        assertPasswordAcceptable(newPassword, row.email); // refused BEFORE the token is consumed, so the user can try again
      } catch (err) {
        if (err instanceof AppError && err.details) throw new AppError(err.status, err.code, err.message, err.details.map((d) => ({ ...d, path: 'newPassword' })));
        throw err;
      }
      const newHash = await hashPassword(newPassword);
      await tx.query('UPDATE users SET password_hash = $2, updated_at = $3 WHERE id = $1', [row.user_id, newHash, now]);
      await tx.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [row.user_id]);
      const del = await tx.query('DELETE FROM sessions WHERE user_id = $1', [row.user_id]);
      return { ...row, revoked: del.rowCount ?? 0 };
    });
    if (!done) throw new AppError(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired. Links work once and last an hour.');
    req.log?.info({ event: 'password_reset', userId: done.user_id, sessionsRevoked: done.revoked }, 'password reset');
    if (mailer.configured) {
      void mailer
        .send({
          to: done.email,
          subject: 'Your SubCycle password was changed',
          text: `Hi ${done.display_name},\n\nThe password for your SubCycle account was just changed using a reset link, and you were signed out everywhere. If this was you, no action is needed. If it was not, reset your password again and check who has access to your email.\n`,
        })
        .catch((err: unknown) => req.log?.warn({ err }, 'password changed notice delivery failed'));
    }
    res.json({ data: { reset: true } });
  });

  // Idempotent: always succeeds and clears the cookie, whether or not a valid session existed.
  router.post('/logout', async (req, res) => {
    if (req.auth) await deleteSessionById(pool, req.auth.sessionId);
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  router.get('/me', requireAuth, async (req, res) => {
    const auth = req.auth!;
    res.json({
      data: {
        user: toUserDto({ id: auth.userId, email: auth.email, displayName: auth.displayName, emailVerifiedAt: auth.emailVerifiedAt }),
        preferences: await loadPreferences(pool, auth.userId),
        features: { emailVerificationAvailable: mailer.configured },
      },
    });
  });

  return router;
}
