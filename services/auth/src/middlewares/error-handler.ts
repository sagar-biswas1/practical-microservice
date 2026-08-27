import type { ErrorRequestHandler } from "express";
import { isProduction } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { toAppError } from "../errors/normalize.js";
import type { ErrorCodeValue, ErrorDetail } from "../errors/app-error.js";

export interface ErrorBody {
  success: false;
  error: {
    code: ErrorCodeValue;
    message: string;
    details?: ErrorDetail[];
    requestId?: string;
    stack?: string;
  };
}

/**
 * Terminal error middleware. Must be registered last, and must keep all four
 * parameters — Express identifies error handlers by arity.
 *
 * With the error-first convention, most failures reach here because a
 * controller destructured `[error, data]` and passed the error to `next`.
 * The rest arrive as genuine throws from the framework itself (a malformed
 * body, an oversized payload), so the normaliser still has to run.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = toAppError(err);
  const log = req.log ?? logger;

  // `req.log` is already bound to the correlation id; re-adding it here would
  // emit a duplicate `requestId` key.
  const logPayload = {
    ...(req.log ? {} : { requestId: req.id }),
    method: req.method,
    url: req.originalUrl,
    statusCode: appError.statusCode,
    code: appError.code,
    err: appError,
  };

  if (appError.isOperational && appError.statusCode < 500) {
    log.warn(logPayload, "request_failed");
  } else {
    log.error(logPayload, "request_error");
  }

  // Headers already flushed (e.g. a stream failed mid-response) — let Express
  // destroy the socket rather than attempting a second write.
  if (res.headersSent) {
    res.end();
    return;
  }

  const exposeMessage = appError.isOperational || !isProduction;

  const body: ErrorBody = {
    success: false,
    error: {
      code: appError.code,
      message: exposeMessage ? appError.message : "Internal server error",
      ...(appError.details ? { details: appError.details } : {}),
      ...(req.id ? { requestId: req.id } : {}),
      ...(isProduction ? {} : { stack: appError.stack }),
    },
  };

  res.status(appError.statusCode).json(body);
};
