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
