import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import { AppError, ErrorCode } from "../errors/app-error.js";

/**
 * Rejects oversized bodies before they are relayed upstream.
 *
 * The gateway never parses request bodies — doing so would consume the stream
 * the proxy has to forward — so this checks the declared `Content-Length`
 * instead of counting bytes. A chunked request carries no length and passes
 * through; bounding those means buffering, which is exactly what the upstream
 * body parser already does with full knowledge of the payload.
 */
export const bodyLimit: RequestHandler = (req, _res, next) => {
  const declared = req.get("content-length");
  if (!declared) {
    next();
    return;
  }

  const bytes = Number(declared);
  if (!Number.isFinite(bytes) || bytes <= env.MAX_BODY_BYTES) {
    next();
    return;
  }

  next(
    new AppError(
      `Request body exceeds the ${env.MAX_BODY_BYTES} byte limit`,
      413,
      ErrorCode.BAD_REQUEST,
    ),
  );
};
