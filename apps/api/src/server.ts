import { createApp } from './app.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { purgeExpiredSessions } from './auth/sessions.js';
import { createPool } from './db/pool.js';
import { createMailer } from './mail/mailer.js';
import { rollForwardStale } from './services/recurrence.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const mailer = createMailer(config.smtp);
const app = createApp({ config, pool, clock: systemClock, mailer });

const server = app.listen(config.port, () => {
  console.log(`SubCycle API listening on :${config.port} (${config.env}); email ${mailer.configured ? 'enabled' : 'DISABLED (no SMTP configured)'}`);
});

// Housekeeping until the Stage 7 scheduler exists. This is a background JOB, never part of a read request:
//  - drop sessions that can no longer authenticate
//  - persist the roll-forward of stale next-billing dates (creates no payments)
async function housekeeping(): Promise<void> {
  try {
    await purgeExpiredSessions(pool, systemClock);
    const rolled = await rollForwardStale(pool, systemClock);
    if (rolled > 0) console.log(`rolled forward ${rolled} subscription billing date(s)`);
  } catch (err) {
    console.error('housekeeping failed', (err as Error).message);
  }
}
void housekeeping();
const purgeTimer = setInterval(() => void housekeeping(), 60 * 60 * 1000);
purgeTimer.unref();

function shutdown(): void {
  clearInterval(purgeTimer);
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
