import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { corsOrigins, env } from "./config/env.js";
import { createDocsRouter } from "./docs/docs.routes.js";
import { errorHandler } from "./middlewares/error-handler.js";
import { notFoundHandler } from "./middlewares/not-found-handler.js";
import {
  requestContext,
  REQUEST_ID_HEADER,
} from "./middlewares/request-context.js";
import { requestLogger } from "./middlewares/request-logger.js";
import {
  API_PREFIX,
  createApiRouter,
  type RouterDependencies,
} from "./routes/index.js";

export type AppDependencies = RouterDependencies;

/**
 * Builds the Express app from injected dependencies.
 *
 * Kept separate from `server.ts` so tests can mount the real middleware stack
 * against fake services without opening a port or touching Postgres.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  // Behind a gateway/ingress: trust X-Forwarded-* so client IPs are accurate.
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
      exposedHeaders: [REQUEST_ID_HEADER],
    }),
  );

  // Docs before anything that can reject a request, so `/docs` stays reachable
  // regardless of what the API stack in front of the routes decides. The router
  // matches only `/docs` and `/openapi.json`; everything else falls straight
  // through.
  app.use(createDocsRouter());

  app.use((req, res, next) => {
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers["x-forwarded-host"];
    const fullUrl = `${protocol}://${host}`;
    if (Array.isArray(corsOrigins) && corsOrigins.includes(fullUrl)) {
      next();
    } else {
      res.status(403).json({ error: "Forbidden" });
    }
  });

  // Before the body parsers: a malformed-JSON error must still carry a
  // correlation id and show up in the access log.
  app.use(requestContext);
  app.use(requestLogger);

  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: env.BODY_LIMIT }));

  app.get("/", (_req, res) => {
    res.json({
      success: true,
      data: {
        service: env.SERVICE_NAME,
        version: "1.0.0",
        apiPrefix: API_PREFIX,
      },
    });
  });

  app.use(API_PREFIX, createApiRouter(deps));

  // Order matters: 404 first, then the terminal error handler.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
