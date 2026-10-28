import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { describeError } from './errorLog.js';
import { createLogger } from './logger.js';
import type { AppDeps } from './deps.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { loadSession } from './middleware/session.js';
import { accountRouter } from './routes/account.js';
import { authRouter } from './routes/auth.js';
import { insightsRouters } from './routes/insights.js';
import { subscriptionsRouter } from './routes/subscriptions.js';

export function createApp(deps: AppDeps): Express {
  const { config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const logger = deps.logger ?? createLogger(config);
  app.use(
    pinoHttp({
      logger,
      // Always server-generated: never trust a client-supplied id (log injection).
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Log method + path only: no headers, query string, or bodies.
      serializers: {
        // pino-http installs its own full `err` serializer (message, stack, every property) unless told otherwise.
        err: describeError,
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url.split('?')[0] }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(helmet({ referrerPolicy: { policy: 'no-referrer' } }));
  app.use(
    cors({
      // Same-origin and non-browser requests send no Origin and are unaffected; browsers on other origins are denied unless allowlisted.
      origin: (origin, cb) => cb(null, origin !== undefined && config.corsOrigins.includes(origin)),
      credentials: true,
      allowedHeaders: ['Content-Type', 'X-SubCycle-Client'],
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      maxAge: 600,
    }),
  );

  app.get('/api/health', (_req, res) => {
    res.json({ data: { status: 'ok' } });
  });
  // Readiness: can this instance reach its database? (Liveness above never touches it.) Reveals nothing about why it failed.
  // Own rate-limit bucket: an anonymous flood must not be able to exhaust the connection pool through this route.
  app.get('/api/health/ready', apiLimiter(config.rateLimit.apiWindowMs, config.rateLimit.apiMax), async (_req, res) => {
    try {
      await deps.pool.query('SELECT 1');
      res.json({ data: { status: 'ok', database: 'ok' } });
    } catch {
      res.status(503).json({ error: { code: 'NOT_READY', message: 'The service is not ready.' } });
    }
  });

  app.use('/api', csrfProtection(config));
  app.use('/api', apiLimiter(config.rateLimit.apiWindowMs, config.rateLimit.apiMax));
  app.use(express.json({ limit: '100kb', strict: true }));
  app.use('/api', loadSession(deps));

  app.use('/api/auth', authRouter(deps));
  app.use('/api/account', accountRouter(deps));
  app.use('/api/subscriptions', subscriptionsRouter(deps));
  const insights = insightsRouters({ ...deps, logger });
  app.use('/api/calendar', insights.calendar);
  app.use('/api/analytics', insights.analytics);
  app.use('/api/reminders', insights.reminders);
  app.use('/api/preferences', insights.preferences);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
