import { ZodError } from "zod";
import {
  AppError,
  ErrorCode,
  InternalServerError,
  ValidationError,
  type ErrorDetail,
} from "./app-error.js";

/**
 * Turns anything thrown anywhere in the stack into an `AppError`.
 *
 * Deliberately free of Express types: the repository calls it (through
 * `attempt`) to convert a Prisma rejection into an error-first result long
 * before the HTTP layer is involved, and the error middleware calls it again
 * as a backstop for anything that still arrives as a raw throw.
 */

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

export function zodIssuesToDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
    code: issue.code,
  }));
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
