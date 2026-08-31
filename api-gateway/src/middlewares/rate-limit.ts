import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { env, isTest } from "../config/env.js";
import { TooManyRequestsError } from "../errors/app-error.js";

/**
 * Per-IP throttle on proxied traffic.
 *
 * Counters live in memory, so each gateway replica enforces the limit on its
 * own — with N replicas behind a load balancer the effective ceiling is N
 * times `RATE_LIMIT_MAX`. That is acceptable for coarse abuse protection;
 * a shared store (Redis) is what makes the limit exact.
 */
export const rateLimiter: RequestHandler = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  // `RateLimit`/`RateLimit-Policy`, not the legacy `X-RateLimit-*` pair.
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // Tests drive many requests through one app instance; throttling them would
  // make assertions depend on execution order.
  skip: () => isTest,
  // Delegate to the error middleware so a 429 carries the same envelope,
  // correlation id, and log line as every other failure.
  handler: (_req, _res, next) => {
    next(new TooManyRequestsError("Too many requests, please retry later"));
  },
});

export interface StrictRateLimitOptions {
  /** Appears in the 429 message so a caller knows which budget it hit. */
  name: string;
  windowMs: number;
  limit: number;
  /**
   * Overridable so a test can exercise the limiter itself. Everything else
   * skips under `NODE_ENV=test`, for the reason given above.
   */
  skip?: () => boolean;
}

/**
 * A second, tighter throttle for a named set of routes.
 *
 * Each call builds its own store, so one instance is one bucket: share an
 * instance across the routes that should draw on a common allowance, and
 * create a separate one where the budgets are meant to be independent.
 *
 * The general limiter still applies — these compose rather than replace, and a
 * request counted here was already counted there.
 */
export function createStrictRateLimiter({
  name,
  windowMs,
  limit,
  skip = () => isTest,
}: StrictRateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip,
    handler: (_req, _res, next) => {
      next(new TooManyRequestsError(`Too many ${name} requests, please retry later`));
    },
  });
}
