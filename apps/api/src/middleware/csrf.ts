import type { RequestHandler } from 'express';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated, state-changing requests (layered on SameSite=Lax):
 *  1. a custom header that cross-site forms cannot set and that CORS preflight blocks for non-allowlisted origins;
 *  2. if the browser sent an Origin header, it must be on the allowlist.
 * GET routes never mutate state, so they are exempt.
 */
export function csrfProtection(config: Config): RequestHandler {
  const allowed = new Set(config.corsOrigins);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    if (req.get('x-subcycle-client') !== 'web' || (origin !== undefined && !allowed.has(origin))) {
      return next(new AppError(403, 'CSRF_REJECTED', 'Request rejected.'));
    }
    next();
  };
}
