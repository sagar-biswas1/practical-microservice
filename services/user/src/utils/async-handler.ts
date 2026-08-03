import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

/**
 * Forwards rejected promises to the error middleware.
 *
 * Express 5 already does this for async handlers; wrapping is kept because it
 * makes the intent explicit at the route definition and keeps handlers safe if
 * one is ever mounted on a v4-style router.
 */
export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
