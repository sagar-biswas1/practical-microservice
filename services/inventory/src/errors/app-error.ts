/**
 * Machine-readable error codes returned to clients as `error.code`.
 * Clients should branch on these, never on the human-readable message.
 */
export const ErrorCode = {
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  UNPROCESSABLE_ENTITY: "UNPROCESSABLE_ENTITY",
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorDetail {
  field?: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Base class for every error this service raises deliberately.
 *
 * `isOperational` distinguishes expected failures (bad input, missing row)
 * from bugs. Operational errors are logged at `warn` and surfaced verbatim;
 * everything else is logged at `error` and reported to the client as a
 * generic 500 so internals never leak.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly isOperational: boolean;
  readonly details?: ErrorDetail[];

  constructor(
    message: string,
    statusCode = 500,
    code: ErrorCodeValue = ErrorCode.INTERNAL_SERVER_ERROR,
    options: { details?: ErrorDetail[]; isOperational?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = options.isOperational ?? true;
    if (options.details) this.details = options.details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: ErrorDetail[]) {
    super(message, 400, ErrorCode.BAD_REQUEST, { details });
  }
}

export class ValidationError extends AppError {
  constructor(message = "Request validation failed", details?: ErrorDetail[]) {
    super(message, 422, ErrorCode.VALIDATION_ERROR, { details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(message, 401, ErrorCode.UNAUTHORIZED);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Insufficient permissions") {
    super(message, 403, ErrorCode.FORBIDDEN);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(message, 404, ErrorCode.NOT_FOUND);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Resource conflict", details?: ErrorDetail[]) {
    super(message, 409, ErrorCode.CONFLICT, { details });
  }
}

export class UnprocessableEntityError extends AppError {
  constructor(message = "Unprocessable entity", details?: ErrorDetail[]) {
    super(message, 422, ErrorCode.UNPROCESSABLE_ENTITY, { details });
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests") {
    super(message, 429, ErrorCode.TOO_MANY_REQUESTS);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable", cause?: unknown) {
    super(message, 503, ErrorCode.SERVICE_UNAVAILABLE, { cause });
  }
}

export class InternalServerError extends AppError {
  constructor(message = "Internal server error", cause?: unknown) {
    super(message, 500, ErrorCode.INTERNAL_SERVER_ERROR, {
      cause,
      isOperational: false,
    });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
