import express, { type Express, type RequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import { corsOrigins, env, trustProxy } from "./config/env.js";
import { serviceRegistry } from "./config/services.js";
import { bodyLimit } from "./middlewares/body-limit.js";
import { errorHandler } from "./middlewares/error-handler.js";
import { notFoundHandler } from "./middlewares/not-found-handler.js";
import { rateLimiter } from "./middlewares/rate-limit.js";
import { requestContext, REQUEST_ID_HEADER } from "./middlewares/request-context.js";
import { requestLogger } from "./middlewares/request-logger.js";
import { createServiceProxies } from "./proxy/service-proxy.js";
import { API_PREFIX, createApiRouter, type RouterDependencies } from "./routes/index.js";

export interface AppDependencies extends RouterDependencies {
  /**
   * Upstream proxies, in match order. Injected so tests can stand in fake
   * handlers instead of running the product and inventory services.
   */
  proxies?: RequestHandler[];
}

/**
 * Builds the Express app from injected dependencies.
 *
 * Kept separate from `server.ts` so tests can mount the real middleware stack
 * without opening a port or requiring the upstream services to be running.
 */
export function createApp(deps: AppDependencies = {}): Express {
  const app = express();

  // Decides whether X-Forwarded-For is believed, and so what `req.ip` — the
  // rate limiter's key — resolves to. Scoped rather than blanket-`true`: see
  // TRUST_PROXY in config/env.ts.
  app.set("trust proxy", trustProxy);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
      exposedHeaders: [REQUEST_ID_HEADER],
    }),
  );

  // Before anything that can fail: a rejected request must still carry a
  // correlation id and show up in the access log.
  app.use(requestContext);
  app.use(requestLogger);

  // No body parsers anywhere in this stack, deliberately. Parsing consumes the
  // request stream, and the proxy needs to pipe that stream to the upstream
  // untouched — a parsed body would leave the proxied request hanging with no
  // payload. Only the declared size is inspected.
  app.use(bodyLimit);

  app.get("/", (_req, res) => {
    res.json({
      success: true,
      data: {
        service: env.SERVICE_NAME,
        version: "1.0.0",
        apiPrefix: API_PREFIX,
        upstreams: serviceRegistry.map(({ name, prefix }) => ({ name, prefix })),
      },
    });
  });

  // Mounted ahead of the limiter so liveness and readiness probes — which run
  // on a fixed schedule and can be frequent — are never throttled.
  app.use(API_PREFIX, createApiRouter(deps));

  app.use(rateLimiter);

  // Mounted without a path: Express strips a mount prefix from `req.url`, and
  // the proxies forward `req.url` as-is. Each one filters on the full path
  // internally and calls `next()` when it does not own the route.
  for (const proxy of deps.proxies ?? createServiceProxies()) {
    app.use(proxy);
  }

  // Order matters: 404 first, then the terminal error handler.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
