import { Router, type RequestHandler } from "express";
import { env } from "../../config/env.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/api-response.js";
import { ErrorCode } from "../../errors/app-error.js";

export type ReadinessCheck = () => Promise<void>;

/**
 * `/health/live`  — process is up (orchestrator restart signal).
 * `/health/ready` — dependencies reachable (load-balancer traffic signal).
 */
export function createHealthRouter(checkReadiness?: ReadinessCheck): Router {
  const router = Router();

  const liveness: RequestHandler = (_req, res) => {
    sendSuccess(res, {
      status: "ok",
      service: env.SERVICE_NAME,
      uptimeSeconds: Math.round(process.uptime()),
    });
  };

  router.get("/", liveness);
  router.get("/live", liveness);

  router.get(
    "/ready",
    asyncHandler(async (_req, res) => {
      if (!checkReadiness) {
        sendSuccess(res, { status: "ready", dependencies: {} });
        return;
      }

      try {
        await checkReadiness();
      } catch (error) {
        // Answered here rather than via `next(error)`: a readiness probe is a
        // status report, not a failed request, and it must stay a plain 503
        // even when the error handler would classify the cause differently.
        res.status(503).json({
          success: false,
          error: {
            code: ErrorCode.SERVICE_UNAVAILABLE,
            message: "One or more dependencies are unavailable",
            details: [
              {
                field: "database",
                message: error instanceof Error ? error.message : "unknown error",
              },
            ],
          },
        });
        return;
      }

      sendSuccess(res, { status: "ready", dependencies: { database: "up" } });
    }),
  );

  return router;
}
