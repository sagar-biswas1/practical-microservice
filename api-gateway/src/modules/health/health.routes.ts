import { Router, type RequestHandler } from "express";
import { env } from "../../config/env.js";
import { serviceRegistry, type ServiceRoute } from "../../config/services.js";
import { asyncHandler } from "../../utils/async-handler.js";
import { sendSuccess } from "../../utils/api-response.js";

export interface DependencyStatus {
  status: "up" | "down";
  latencyMs: number;
  message?: string;
}

export type DependencyReport = Record<string, DependencyStatus>;

/** Swappable so tests can report dependency states without real upstreams. */
export type ReadinessCheck = () => Promise<DependencyReport>;

/**
 * Probes one upstream's liveness endpoint.
 *
 * Never rejects: a down dependency is a reportable state, not an error, and
 * one unreachable service must not hide the status of the others.
 */
async function probe(route: ServiceRoute, timeoutMs: number): Promise<DependencyStatus> {
  const startedAt = process.hrtime.bigint();
  const elapsedMs = (): number =>
    Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  try {
    const response = await fetch(`${route.target}${route.healthPath}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      return {
        status: "down",
        latencyMs: Math.round(elapsedMs()),
        message: `HTTP ${response.status}`,
      };
    }

    return { status: "up", latencyMs: Math.round(elapsedMs()) };
  } catch (error) {
    return {
      status: "down",
      latencyMs: Math.round(elapsedMs()),
      message: error instanceof Error ? error.message : "unknown error",
    };
  }
}

/** Probes every registered upstream concurrently. */
export async function checkUpstreams(): Promise<DependencyReport> {
  const results = await Promise.all(
    serviceRegistry.map(async (route) => [route.name, await probe(route, env.HEALTH_TIMEOUT_MS)] as const),
  );

  return Object.fromEntries(results);
}

/**
 * `/health/live`  — process is up (orchestrator restart signal).
 * `/health/ready` — upstreams reachable (load-balancer traffic signal).
 *
 * Liveness deliberately ignores the upstreams: a gateway whose dependencies
 * are down is still a healthy process, and restarting it would not help.
 */
export function createHealthRouter(checkReadiness: ReadinessCheck = checkUpstreams): Router {
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
      const dependencies = await checkReadiness();
      const degraded = Object.entries(dependencies).filter(
        ([, status]) => status.status === "down",
      );

      if (degraded.length > 0) {
        res.status(503).json({
          success: false,
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "One or more upstream services are unavailable",
            details: degraded.map(([name, status]) => ({
              field: name,
              message: status.message ?? "unreachable",
            })),
          },
          data: { status: "degraded", dependencies },
        });
        return;
      }

      sendSuccess(res, { status: "ready", dependencies });
    }),
  );

  return router;
}
