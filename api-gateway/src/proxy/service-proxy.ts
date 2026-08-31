import type { Socket } from "node:net";
import type { Request, RequestHandler, Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { env } from "../config/env.js";
import { routePolicies } from "../config/route-policies.js";
import type { ServiceRoute } from "../config/services.js";
import { serviceRegistry } from "../config/services.js";
import { createPolicyHandlers } from "./route-policy.js";
import { logger } from "../lib/logger.js";
import {
  AppError,
  BadGatewayError,
  GatewayTimeoutError,
  ServiceUnavailableError,
} from "../errors/app-error.js";
import { buildErrorBody } from "../middlewares/error-handler.js";

/** A `res` that is a real HTTP response rather than a raw upgraded socket. */
function isServerResponse(res: Response | Socket): res is Response {
  return typeof (res as Response).writeHead === "function";
}

/**
 * Maps a transport-level failure onto the status the client should see.
 *
 * The distinction that matters to a caller is whether retrying could help:
 * 503 means the upstream never accepted the request (safe to retry), 504
 * means it accepted and then ran out of time (a write may have landed).
 */
function toGatewayError(error: NodeJS.ErrnoException, route: ServiceRoute): AppError {
  const code = error.code ?? "";

  // A malformed status line or header block from the upstream.
  if (code.startsWith("HPE_")) {
    return new BadGatewayError(`Invalid response from ${route.name} service`, error);
  }

  switch (code) {
    case "ECONNREFUSED":
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return new ServiceUnavailableError(`${route.name} service is unreachable`, error);

    // `proxyTimeout` aborts the outbound request, which surfaces as a reset
    // rather than a distinct timeout code — hence both land here.
    case "ECONNRESET":
    case "ETIMEDOUT":
    case "ESOCKETTIMEDOUT":
      return new GatewayTimeoutError(`${route.name} service did not respond in time`, error);

    default:
      return new BadGatewayError(`Failed to reach ${route.name} service`, error);
  }
}

/**
 * Builds the reverse proxy for one upstream.
 *
 * Mounted without a mount path and narrowed by `pathFilter`, because Express
 * strips the mount prefix from `req.url` and this proxy forwards `req.url`
 * verbatim. Mounting it at `app.use(prefix, proxy)` would therefore send
 * `/api/v1/products/42` upstream as `/42`.
 */
export function createServiceProxy(route: ServiceRoute): RequestHandler {
  const proxy = createProxyMiddleware<Request, Response>({
    target: route.target,
    changeOrigin: true,
    proxyTimeout: env.PROXY_TIMEOUT_MS,
    // Exact-boundary match: a string filter is a plain prefix test, which
    // would also capture sibling paths like `/api/v1/products-internal`.
    pathFilter: (pathname) =>
      pathname === route.prefix || pathname.startsWith(`${route.prefix}/`),
    // Adds x-forwarded-for/host/port/proto so upstreams see the real client.
    xfwd: true,
    // http-proxy-middleware's own logging is redundant with morgan and prints
    // outside the structured sink; only its errors are worth surfacing.
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: {
      proxyRes: (proxyRes, req) => {
        req.log?.debug(
          {
            upstream: route.name,
            target: route.target,
            upstreamStatus: proxyRes.statusCode,
          },
          "proxy_response",
        );
      },

      /**
       * Defining this handler replaces the library's default text/plain error
       * page, so every failure — including this one — leaves the gateway in
       * the standard JSON envelope.
       */
      error: (error, req, res) => {
        const appError = toGatewayError(error as NodeJS.ErrnoException, route);
        const log = req.log ?? logger;

        log.error(
          {
            upstream: route.name,
            target: route.target,
            method: req.method,
            url: req.url,
            statusCode: appError.statusCode,
            code: appError.code,
            err: error,
          },
          "proxy_error",
        );

        // A websocket upgrade hands back the raw socket; there is no response
        // to write, so the only correct move is to drop the connection.
        if (!isServerResponse(res)) {
          res.destroy();
          return;
        }

        // The upstream died after the status line was relayed. The client has
        // a partial body and no way to be told otherwise — end the response so
        // it sees a truncated payload rather than a hung connection.
        if (res.headersSent) {
          res.end();
          return;
        }

        res.status(appError.statusCode).json(buildErrorBody(appError, req.id));
      },
    },
  });

  return proxy as RequestHandler;
}

/** One proxy per registry entry, in declaration order. */
export function createServiceProxies(): RequestHandler[] {
  return serviceRegistry.map(createServiceProxy);
}

/**
 * The full upstream chain: each service's edge policies followed by its proxy,
 * concatenated in registry order.
 *
 * Flat rather than nested because every handler is mounted at the root — see
 * `route-policy.ts` for why nothing here can carry a mount path. A policy that
 * does not cover a request calls `next()`, and since the prefixes are disjoint
 * a request only ever reaches the policies of the service that owns it.
 *
 * The proxy is last within each group and terminal: once it matches, nothing
 * declared after it runs.
 */
export function createServiceHandlers(): RequestHandler[] {
  return serviceRegistry.flatMap((route) => [
    ...createPolicyHandlers(route, routePolicies[route.name]),
    createServiceProxy(route),
  ]);
}
