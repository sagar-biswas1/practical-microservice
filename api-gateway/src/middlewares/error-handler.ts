import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { isProduction } from "../config/env.js";
import { logger } from "../lib/logger.js";
import {
  AppError,
  ErrorCode,
  InternalServerError,
  ValidationError,
  type ErrorCodeValue,
  type ErrorDetail,
} from "../errors/app-error.js";

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

/** Body-parser failures carry a `type` discriminator and an HTTP status. */
interface HttpBodyError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

function zodIssuesToDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Normalises anything thrown anywhere in the stack into an `AppError`.
 *
 * Deliberately free of database cases: the gateway holds no persistence, so
 * everything it raises is either a client problem or an upstream one, and the
 * latter is already translated by the proxy before it reaches here.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new ValidationError("Request validation failed", zodIssuesToDetails(error));
  }

  if (error instanceof SyntaxError) {
    const bodyError = error as HttpBodyError;
    if (bodyError.type === "entity.parse.failed") {
      return new AppError("Malformed JSON in request body", 400, ErrorCode.BAD_REQUEST, {
        cause: error,
      });
    }
  }

  const httpError = error as HttpBodyError;
  if (httpError?.type === "entity.too.large") {
    return new AppError("Request body too large", 413, ErrorCode.BAD_REQUEST, { cause: error });
  }

  return new InternalServerError(
    error instanceof Error ? error.message : "Internal server error",
    error,
  );
}

/**
 * Builds the client-facing error envelope.
 *
 * Exported because the proxy cannot always reach the Express error middleware
 * — an upstream failure can surface in a raw `http` callback, after Express
 * has handed the socket over — and both paths must produce the same shape.
 */
export function buildErrorBody(appError: AppError, requestId?: string): ErrorBody {
  // A non-operational error is a bug in this process; its message may name
  // internal hosts or config, so production sees only a generic string.
  const exposeMessage = appError.isOperational || !isProduction;

  return {
    success: false,
    error: {
      code: appError.code,
      message: exposeMessage ? appError.message : "Internal server error",
      ...(appError.details ? { details: appError.details } : {}),
      ...(requestId ? { requestId } : {}),
      ...(isProduction ? {} : { stack: appError.stack }),
    },
  };
}

/**
 * Terminal error middleware. Must be registered last, and must keep all four
 * parameters — Express identifies error handlers by arity.
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

  // Headers already flushed (e.g. an upstream died mid-response) — let Express
  // destroy the socket rather than attempting a second write.
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(appError.statusCode).json(buildErrorBody(appError, req.id));
};
