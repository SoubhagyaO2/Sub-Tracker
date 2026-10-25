import type { Config } from '../config.js';
import type { Clock } from '../clock.js';
import type { Queryable } from '../db/pool.js';
import { generateToken, hashToken } from './tokens.js';

export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  emailVerifiedAt: Date | null;
}

export interface CreatedSession {
  token: string;
  expiresAt: Date; // absolute expiry; used for the cookie's Expires attribute
}

/** Creates a session row. All timestamps come from the injected clock, never from the DB's now(). */
export async function createSession(
  db: Queryable,
  config: Config,
  clock: Clock,
  userId: string,
  userAgent?: string,
): Promise<CreatedSession> {
  const token = generateToken();
  const now = clock.now();
  const idleExpires = new Date(now.getTime() + config.session.idleMs);
  const absoluteExpires = new Date(now.getTime() + config.session.absoluteMs);
  await db.query(
    `INSERT INTO sessions
       (user_id, token_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at, user_agent)
     VALUES ($1, $2, $3, $3, $4, $5, $6)`,
    [userId, hashToken(token), now, idleExpires, absoluteExpires, userAgent?.slice(0, 300) ?? null],
  );
  return { token, expiresAt: absoluteExpires };
}

interface SessionRow {
  id: string;
  user_id: string;
  last_seen_at: Date;
  email: string;
  display_name: string;
  email_verified_at: Date | null;
}

/**
 * Resolves a cookie token to an authenticated user, or null if unknown/expired.
 * A session is valid only while BOTH the sliding idle expiry and the absolute expiry are in the future.
 * Activity extends the idle expiry (throttled) but never the absolute expiry.
 */
export async function authenticateToken(
  db: Queryable,
  config: Config,
  clock: Clock,
  token: string,
): Promise<AuthContext | null> {
  const now = clock.now();
  const { rows } = await db.query<SessionRow>(
    `SELECT s.id, s.user_id, s.last_seen_at, u.email, u.display_name, u.email_verified_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.idle_expires_at > $2
        AND s.absolute_expires_at > $2`,
    [hashToken(token), now],
  );
  const row = rows[0];
  if (!row) return null;

  if (now.getTime() - row.last_seen_at.getTime() >= config.session.touchIntervalMs) {
    await db.query('UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1', [
      row.id,
      now,
      new Date(now.getTime() + config.session.idleMs),
    ]);
  }
  return {
    sessionId: row.id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    emailVerifiedAt: row.email_verified_at,
  };
}

export async function deleteSessionById(db: Queryable, sessionId: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

export async function deleteSessionsForUser(
  db: Queryable,
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)', [
    userId,
    exceptSessionId ?? null,
  ]);
}

/** Removes sessions that can no longer authenticate. Returns the number removed. */
export async function purgeExpiredSessions(db: Queryable, clock: Clock): Promise<number> {
  const result = await db.query(
    'DELETE FROM sessions WHERE idle_expires_at <= $1 OR absolute_expires_at <= $1',
    [clock.now()],
  );
  return result.rowCount ?? 0;
}
