import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'Not found.'));
};

interface BodyParserError {
  type?: string;
  status?: number;
}

/** Maps every failure to the documented envelope. Responses never contain stack traces, SQL, or internals. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong. Please try again.';
  let details: AppError['details'];

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Please check the highlighted fields.';
    details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  } else {
    const bp = err as BodyParserError;
    if (bp.type === 'entity.too.large') {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'Request body is too large.';
    } else if (bp.type === 'entity.parse.failed' || bp.type === 'encoding.unsupported' || err instanceof SyntaxError) {
      status = 400;
      code = 'MALFORMED_REQUEST';
      message = 'The request body could not be read.';
    }
  }

  // Server errors: log sanitized diagnostics under the request id; tell the client only the id (never the cause).
  const requestId = typeof (req as { id?: unknown }).id === 'string' ? (req as { id: string }).id : undefined;
  if (status >= 500) req.log?.error({ event: 'request_failed', status, err }, 'request failed');
  if (!res.headersSent) {
    res.status(status).json({ error: { code, message, ...(details ? { details } : {}), ...(status >= 500 && requestId ? { requestId } : {}) } });
  }
};
