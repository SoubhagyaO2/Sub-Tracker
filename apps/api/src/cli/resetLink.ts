import { createResetToken, resetLink } from '../auth/passwordReset.js';
import { systemClock } from '../clock.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

/**
 * Operator tool for servers WITHOUT an email provider: prints a one-time password-reset link for an account.
 * Needs the same environment (DATABASE_URL, APP_URL) as the API, so only someone with access to the server can run it.
 *   npm run admin:reset-link -w @subcycle/api -- person@example.com
 * The link is a credential: send it only to the account's owner, over a channel you trust. It works once and expires
 * (see passwordReset.tokenTtlMs); asking for another link invalidates the previous one.
 */
const email = process.argv[2]?.trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Usage: npm run admin:reset-link -w @subcycle/api -- <account email>');
  process.exit(2);
}

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [email]);
  if (!rows[0]) {
    console.error('No account with that email address.');
    process.exitCode = 1;
  } else {
    const token = await createResetToken(pool, config, systemClock, rows[0].id);
    const minutes = Math.round(config.passwordReset.tokenTtlMs / 60_000);
    console.log(`One-time reset link (valid for ${minutes} minutes, works once; anyone holding it can set this account's password):`);
    console.log(resetLink(config, token));
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
