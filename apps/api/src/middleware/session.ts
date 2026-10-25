import type { RequestHandler } from 'express';
import type { Clock } from '../clock.js';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { authenticateToken } from '../auth/sessions.js';
import { unauthorized } from '../errors.js';
import { clearSessionCookie, readCookie } from './cookies.js';

/** Attaches req.auth when a valid session cookie is present; clears stale cookies. Never rejects. */
export function loadSession(deps: { config: Config; pool: Pool; clock: Clock }): RequestHandler {
  return async (req, res, next) => {
    const token = readCookie(req.headers.cookie, deps.config.session.cookieName);
    if (!token) return next();
    const auth = await authenticateToken(deps.pool, deps.config, deps.clock, token);
    if (auth) req.auth = auth;
    else clearSessionCookie(res, deps.config);
    next();
  };
}

/** Rejects with 401 unless loadSession authenticated the request. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(unauthorized());
  next();
};
