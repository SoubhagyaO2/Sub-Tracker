import { createApp } from './app.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createLogger } from './logger.js';
import { createMailer } from './mail/mailer.js';
import { startScheduler } from './scheduler/index.js';

const config = loadConfig();
const logger = createLogger(config);
const pool = createPool(config.databaseUrl, (err) => logger.error({ event: 'db_pool_error', errorName: err.name, errorCode: (err as { code?: string }).code }, 'idle database client error'));
for (const w of config.warnings) logger.warn({ event: 'config_warning' }, w);
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
/** Stops accepting requests, lets in-flight ones and the running scheduler cycle finish, closes the pool, then exits. */
function shutdown(code = 0): void {
  if (closing) return;
  closing = true;
  logger.info({ event: 'shutting_down' }, 'shutting down');
  const force = setTimeout(() => process.exit(code || 1), 15_000); // never hang on a stuck connection
  force.unref();
  // Stop scheduling at once (a cycle already running finishes), in parallel with draining HTTP requests.
  const schedulerStopped = scheduler?.stop() ?? Promise.resolve();
  server.close(() => {
    void schedulerStopped.finally(() => pool.end().finally(() => process.exit(code)));
  });
  server.closeIdleConnections();
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
// A bug must not leave a half-working process behind: log what class of error it was (never its data) and exit for the supervisor to restart.
process.on('uncaughtException', (err) => {
  logger.fatal({ event: 'uncaught_exception', errorName: err.name }, 'uncaught exception');
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ event: 'unhandled_rejection', errorName: reason instanceof Error ? reason.name : typeof reason }, 'unhandled rejection');
  shutdown(1);
});
