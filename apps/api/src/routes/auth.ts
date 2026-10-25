import { Router } from 'express';
import { loginSchema, registerSchema } from '@subcycle/shared';
import { loadPreferences, toUserDto } from '../auth/dto.js';
import { assertPasswordAcceptable, hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from '../auth/password.js';
import { createSession, deleteSessionById } from '../auth/sessions.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import type { AppDeps } from '../deps.js';
import { AppError, conflict, unauthorized } from '../errors.js';
import { clearSessionCookie, setSessionCookie } from '../middleware/cookies.js';
import { authIpLimiter, loginEmailLimiter } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/session.js';

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

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
