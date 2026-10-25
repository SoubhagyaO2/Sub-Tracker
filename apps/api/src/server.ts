import { createApp } from './app.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createLogger } from './logger.js';
import { createMailer } from './mail/mailer.js';
import { startScheduler } from './scheduler/index.js';

const config = loadConfig();
const logger = createLogger(config);
const pool = createPool(config.databaseUrl);
const mailer = createMailer(config.smtp);
const deps = { config, pool, clock: systemClock, mailer, logger };
const app = createApp(deps);

const server = app.listen(config.port, () => {
  logger.info(
    { event: 'listening', port: config.port, env: config.env, email: mailer.configured ? 'enabled' : 'disabled (no SMTP configured)', scheduler: config.scheduler.enabled },
    'SubCycle API listening',
  );
});

// The scheduler replaces the Stage 5 hourly timer. It is a background JOB, never part of a read request.
// Safe with several API instances sharing one database: a cross-process advisory lock lets only one cycle run at a time.
const scheduler = config.scheduler.enabled ? startScheduler(deps, { intervalMs: config.scheduler.intervalMs }) : null;

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  server.close(() => {
    void (scheduler?.stop() ?? Promise.resolve()).finally(() => pool.end().finally(() => process.exit(0)));
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
