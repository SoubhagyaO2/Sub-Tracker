import type { Writable } from 'node:stream';
import { pino, type Logger } from 'pino';
import type { Config } from './config.js';
import { describeError } from './errorLog.js';

export type { Logger };

/**
 * One logger configuration for the HTTP layer and the scheduler. Structured JSON. Cookies, auth headers and any
 * `password` / `token` / `email` / `note` fields are removed if they ever reach a log call. Callers must still never
 * pass request bodies, message contents or tokens in the first place: redaction is the second line of defence.
 */
export function createLogger(config: Pick<Config, 'logLevel'>, destination?: Writable): Logger {
  return pino(
    {
      level: config.logLevel,
      // Whatever is logged under `err` / `error` anywhere (including pino-http) is reduced to non-data fields.
      serializers: { err: describeError, error: describeError },
      redact: {
        paths: [
          'req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]',
          '*.password', '*.token', '*.email', '*.note', '*.notes', '*.text', '*.subject', '*.to',
        ],
        remove: true,
      },
    },
    destination,
  );
}
