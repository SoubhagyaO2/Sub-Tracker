import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { generateToken, hashToken } from './tokens.js';

/** Where the emailed / operator-printed link points. The token is in the URL FRAGMENT, which browsers never send to any server. */
export function resetLink(config: Config, token: string): string {
  return `${config.appUrl}/reset-password#token=${token}`;
}

/**
 * Creates a fresh reset token for the user and returns it (only its SHA-256 is stored). Any earlier unused token of the
 * same user is deleted, so only the newest link works. Old expired and used tokens are tidied up opportunistically.
 */
export async function createResetToken(db: Queryable, config: Config, clock: Clock, userId: string): Promise<string> {
  const now = clock.now();
  const token = generateToken();
  await db.query('DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await db.query("DELETE FROM password_reset_tokens WHERE expires_at < $1::timestamptz - interval '1 day'", [now]);
  await db.query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4)', [
    userId,
    hashToken(token),
    new Date(now.getTime() + config.passwordReset.tokenTtlMs),
    now,
  ]);
  return token;
}
