import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { pino } from 'pino';
import type { AppDeps } from './deps.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { loadSession } from './middleware/session.js';
import { accountRouter } from './routes/account.js';
import { authRouter } from './routes/auth.js';
import { subscriptionsRouter } from './routes/subscriptions.js';

export function createApp(deps: AppDeps): Express {
  const { config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  const logger = pino({
    level: config.logLevel,
    // Defence in depth: serializers below already drop headers/bodies.
    redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', '*.password', '*.token'], remove: true },
  });
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

  app.use('/api', csrfProtection(config));
  app.use('/api', apiLimiter(config.rateLimit.apiWindowMs, config.rateLimit.apiMax));
  app.use(express.json({ limit: '100kb', strict: true }));
  app.use('/api', loadSession(deps));

  app.use('/api/auth', authRouter(deps));
  app.use('/api/account', accountRouter(deps));
  app.use('/api/subscriptions', subscriptionsRouter(deps));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
