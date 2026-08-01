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
import { zodIssuesToDetails } from "./validate.js";

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

/**
 * Prisma's known-request errors are matched structurally rather than with
 * `instanceof`, so this module stays independent of the generated client
 * (and remains unit-testable without running `prisma generate`).
 */
interface PrismaKnownRequestError extends Error {
  code: string;
  meta?: Record<string, unknown>;
}

function isPrismaKnownRequestError(error: unknown): error is PrismaKnownRequestError {
  return (
    error instanceof Error &&
    error.name === "PrismaClientKnownRequestError" &&
    typeof (error as PrismaKnownRequestError).code === "string" &&
    /^P\d{4}$/.test((error as PrismaKnownRequestError).code)
  );
}

function targetFields(meta: Record<string, unknown> | undefined): string[] {
  const target = meta?.["target"];
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === "string") return [target];
  return [];
}

function fromPrismaError(error: PrismaKnownRequestError): AppError {
  const fields = targetFields(error.meta);
  const details: ErrorDetail[] | undefined = fields.length
    ? fields.map((field) => ({ field, message: `Constraint violated on '${field}'` }))
    : undefined;

  switch (error.code) {
    case "P2002":
      return new AppError(
        fields.length
          ? `A record with this ${fields.join(", ")} already exists`
          : "Unique constraint violation",
        409,
        ErrorCode.CONFLICT,
        { details, cause: error },
      );
    case "P2003":
      return new AppError("Related record does not exist", 409, ErrorCode.CONFLICT, {
        details,
        cause: error,
      });
    case "P2025":
      return new AppError("Requested record does not exist", 404, ErrorCode.NOT_FOUND, {
        cause: error,
      });
    case "P2000":
      return new AppError("Value too long for the target column", 400, ErrorCode.BAD_REQUEST, {
        details,
        cause: error,
      });
    case "P2011":
      return new AppError("Missing required value", 400, ErrorCode.BAD_REQUEST, {
        details,
        cause: error,
      });
    case "P1001":
    case "P1002":
    case "P1008":
    case "P1017":
      return new AppError("Database is unavailable", 503, ErrorCode.SERVICE_UNAVAILABLE, {
        cause: error,
        isOperational: false,
      });
    default:
      return new InternalServerError("Unexpected database error", error);
  }
}

/** Normalises anything thrown anywhere in the stack into an `AppError`. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    return new ValidationError("Request validation failed", zodIssuesToDetails(error));
  }

  if (isPrismaKnownRequestError(error)) return fromPrismaError(error);

  if (error instanceof Error && error.name === "PrismaClientValidationError") {
    return new InternalServerError("Invalid database query", error);
  }

  if (error instanceof Error && error.name === "PrismaClientInitializationError") {
    return new AppError("Database is unavailable", 503, ErrorCode.SERVICE_UNAVAILABLE, {
      cause: error,
      isOperational: false,
    });
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
