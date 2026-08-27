import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { corsOrigins, env } from "./config/env.js";
import { errorHandler } from "./middlewares/error-handler.js";
import { notFoundHandler } from "./middlewares/not-found-handler.js";
import { requestContext, REQUEST_ID_HEADER } from "./middlewares/request-context.js";
import { requestLogger } from "./middlewares/request-logger.js";
import { IDEMPOTENT_REPLAY_HEADER } from "./modules/email/email.controller.js";
import { API_PREFIX, createApiRouter, type RouterDependencies } from "./routes/index.js";

export type AppDependencies = RouterDependencies;

/**
 * Builds the Express app from injected dependencies.
 *
 * Kept separate from `server.ts` so tests can mount the real middleware stack
 * against fake services without opening a port, touching Postgres, or sending
 * anything to a mail provider.
 */
export function createApp(deps: AppDependencies): Express {
  const app = express();

  // Behind a gateway/ingress: trust X-Forwarded-* so client IPs are accurate.
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.use(helmet());
  // Origin enforcement is left to the `cors` middleware alone. A second
  // hand-rolled check in front of it would have to re-derive the origin from
  // forwarded headers, which is both spoofable and wrong for server-to-server
  // callers — and this service has almost no other kind, since the things that
  // send email are other services.
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
      exposedHeaders: [REQUEST_ID_HEADER, IDEMPOTENT_REPLAY_HEADER],
    }),
  );

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
        provider: env.EMAIL_PROVIDER,
      },
    });
  });

  app.use(API_PREFIX, createApiRouter(deps));

  // Order matters: 404 first, then the terminal error handler.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
