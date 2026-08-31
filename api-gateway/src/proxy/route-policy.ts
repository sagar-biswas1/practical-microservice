import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ServiceRoute } from "../config/services.js";

/**
 * Per-route middleware for proxied traffic.
 *
 * The gateway forwards paths verbatim, which rules out the obvious way to put
 * middleware on a nested path — `router.use("/auth/login", handler)` — because
 * Express strips a mount prefix from `req.url` and the proxy sends `req.url`
 * on unchanged. Mounting anything at a path would rewrite the request out from
 * under the proxy. See the note in `service-proxy.ts`.
 *
 * So policies match explicitly instead: every handler is mounted at the root
 * and decides for itself whether the full path belongs to it. `req.url` is
 * never touched, and the matching is plain enough to unit test.
 */

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export interface RoutePolicy {
  /** Label for the policy, used in the debug log when it matches. */
  name: string;
  /**
   * Paths this policy covers, relative to the service's prefix:
   *
   * - `/` — the collection root itself
   * - `/login` — a literal segment
   * - `/:id/adjust` — `:name` matches exactly one segment
   * - `/*` — this path and everything below it; only valid as the last segment
   *
   * A trailing slash on the request is accepted either way, matching what the
   * proxy's own path filter forwards.
   */
  paths: readonly string[];
  /** Methods covered. Omit to cover every method. */
  methods?: readonly HttpMethod[];
  /** Middleware chain, run in order, before the request reaches the proxy. */
  handlers: readonly RequestHandler[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles one pattern into a regex over the *full* request path, prefix
 * included — the handler sees an unmounted `req.path`, so a relative pattern
 * would match sibling services' routes too.
 */
export function compilePolicyPath(prefix: string, pattern: string): RegExp {
  const segments = pattern.split("/").filter(Boolean);

  const body = segments.map((segment, index) => {
    if (segment === "*") {
      if (index !== segments.length - 1) {
        throw new Error(`Wildcard must be the last segment in policy path "${pattern}"`);
      }
      // Optional, so `/*` covers the collection root as well as everything
      // under it — `.` already spans `/`, so this is the whole remainder.
      return "(?:/.*)?";
    }

    if (segment.startsWith(":")) return "/[^/]+";

    return `/${escapeRegExp(segment)}`;
  });

  return new RegExp(`^${escapeRegExp(prefix)}${body.join("")}/?$`);
}

/**
 * Runs a handler chain to completion, then hands control back to Express.
 *
 * Express only threads `next` through handlers it registered itself, so a
 * chain assembled by hand needs its own dispatcher. Any handler that calls
 * `next(error)`, or throws synchronously, short-circuits to the outer `next` —
 * which is what puts a policy rejection in the same error envelope as
 * everything else.
 */
function runChain(
  handlers: readonly RequestHandler[],
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  let index = 0;

  const step: NextFunction = (error?: unknown) => {
    if (error) {
      next(error);
      return;
    }

    const handler = handlers[index++];
    if (!handler) {
      next();
      return;
    }

    try {
      handler(req, res, step);
    } catch (thrown) {
      next(thrown);
    }
  };

  step();
}

/**
 * Turns one policy into a single middleware: a no-op for requests it does not
 * cover, the handler chain for those it does.
 */
export function createPolicyHandler(route: ServiceRoute, policy: RoutePolicy): RequestHandler {
  const patterns = policy.paths.map((path) => compilePolicyPath(route.prefix, path));
  const methods = policy.methods ? new Set<string>(policy.methods) : null;

  return (req, res, next) => {
    if (methods && !methods.has(req.method)) {
      next();
      return;
    }

    if (!patterns.some((pattern) => pattern.test(req.path))) {
      next();
      return;
    }

    req.log?.debug({ upstream: route.name, policy: policy.name }, "policy_matched");

    runChain(policy.handlers, req, res, next);
  };
}

/** One middleware per policy, in declaration order. */
export function createPolicyHandlers(
  route: ServiceRoute,
  policies: readonly RoutePolicy[],
): RequestHandler[] {
  return policies.map((policy) => createPolicyHandler(route, policy));
}
