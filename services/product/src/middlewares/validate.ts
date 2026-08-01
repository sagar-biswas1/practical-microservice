import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodType } from "zod";
import { ValidationError, type ErrorDetail } from "../errors/app-error.js";

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

export interface ValidatedData<TBody = unknown, TQuery = unknown, TParams = unknown> {
  body: TBody;
  query: TQuery;
  params: TParams;
}

export function zodIssuesToDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Validates and coerces the request against Zod schemas.
 *
 * Results go to `req.validated`, never back onto `req.query`/`req.params` —
 * those are getter-only in Express 5, so assigning to them throws. Handlers
 * must read the parsed (and type-coerced) values from `req.validated`.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.params) req.validated.params = schemas.params.parse(req.params);
      if (schemas.query) req.validated.query = schemas.query.parse(req.query);
      if (schemas.body) req.validated.body = schemas.body.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(new ValidationError("Request validation failed", zodIssuesToDetails(error)));
        return;
      }
      next(error);
    }
  };
}

/** Typed accessor for values written by `validate`. */
export function validated<TBody = unknown, TQuery = unknown, TParams = unknown>(
  req: Request,
): ValidatedData<TBody, TQuery, TParams> {
  return req.validated as ValidatedData<TBody, TQuery, TParams>;
}
