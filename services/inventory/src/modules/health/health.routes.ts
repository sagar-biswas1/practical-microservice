import { Router, type RequestHandler } from "express";
import { env } from "../../config/env.js";
import type { BrokerStatus } from "../../messaging/types.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/api-response.js";

export type ReadinessCheck = () => Promise<void>;

/**
 * Reported, not gating. The broker only feeds this service work; losing it
 * means releases wait in the queue, not that requests cannot be served, and
 * failing readiness on it would take every replica out of rotation over a
 * dependency the HTTP path never touches.
 */
export type BrokerStatusCheck = () => BrokerStatus;

const NO_BROKER: BrokerStatusCheck = () => ({ enabled: false, connected: false });

/**
 * `/health/live`  — process is up (orchestrator restart signal).
 * `/health/ready` — dependencies reachable (load-balancer traffic signal).
 */
export function createHealthRouter(
  checkReadiness?: ReadinessCheck,
  brokerStatus: BrokerStatusCheck = NO_BROKER,
): Router {
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
        sendSuccess(res, { status: "ready", dependencies: { broker: brokerStatus() } });
        return;
      }

      try {
        await checkReadiness();
      } catch (error) {
        res.status(503).json({
          success: false,
          error: {
            code: "SERVICE_UNAVAILABLE",
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

      sendSuccess(res, {
        status: "ready",
        dependencies: { database: "up", broker: brokerStatus() },
      });
    }),
  );

  return router;
}
