import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Pool } from './db/pool.js';
import type { Logger } from './logger.js';
import type { Mailer } from './mail/mailer.js';

export interface AppDeps {
  config: Config;
  pool: Pool;
  clock: Clock;
  mailer: Mailer;
  /** Optional: tests inject a logger with a capturing stream; production builds its own from the config. */
  logger?: Logger;
  /** Optional: tests inject a fake page transport / resolver for the pasted-link lookup. */
  linkPreview?: import('./services/linkPreview.js').PreviewDeps;
}
