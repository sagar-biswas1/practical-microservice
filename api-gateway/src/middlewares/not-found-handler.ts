import type { RequestHandler } from "express";
import { NotFoundError } from "../errors/app-error.js";

/** Terminal 404 for unmatched routes — hands off to the error handler. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`));
};
