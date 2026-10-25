import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Pool } from './db/pool.js';
import type { Mailer } from './mail/mailer.js';

export interface AppDeps {
  config: Config;
  pool: Pool;
  clock: Clock;
  mailer: Mailer;
}
