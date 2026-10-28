import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { AppError } from '../errors.js';

function limiter(opts: {
  windowMs: number;
  limit: number;
  skipSuccessfulRequests?: boolean;
  key?: (req: Request) => string;
}): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: opts.skipSuccessfulRequests ?? false,
    keyGenerator: opts.key ?? ((req) => ipKeyGenerator(req.ip ?? 'unknown')),
    handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.')),
  });
}

/** Per-IP limit for auth endpoints (counts every request). */
export const authIpLimiter = (windowMs: number, limit: number) => limiter({ windowMs, limit });

/**
 * Per-account limit for login: keyed by a hash of the submitted email (never logged or stored),
 * counting only failed attempts so legitimate logins never lock the owner out.
 */
export const loginEmailLimiter = (windowMs: number, limit: number) =>
  limiter({
    windowMs,
    limit,
    skipSuccessfulRequests: true,
    key: (req) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
      return 'email:' + createHash('sha256').update(normalized).digest('hex');
    },
  });

/** General per-IP API limit. */
export const apiLimiter = (windowMs: number, limit: number) => limiter({ windowMs, limit });

/**
 * Limits FAILED password confirmations (password change / account deletion) per signed-in user, so a stolen session
 * cannot be used to guess the password. Successful requests are not counted.
 */
export const passwordConfirmLimiter = (windowMs: number, limit: number) =>
  limiter({ windowMs, limit, skipSuccessfulRequests: true, key: (req) => 'user:' + (req.auth?.userId ?? ipKeyGenerator(req.ip ?? 'unknown')) });

/** Per signed-in user: each call may make the server fetch a web page, so it is limited well below the general API limit. */
export const linkPreviewLimiter = (windowMs: number, limit: number) =>
  limiter({ windowMs, limit, key: (req) => 'user:' + (req.auth?.userId ?? ipKeyGenerator(req.ip ?? 'unknown')) });
