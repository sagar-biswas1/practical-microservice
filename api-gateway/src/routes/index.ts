import { Router } from "express";
import { createHealthRouter, type ReadinessCheck } from "../modules/health/health.routes.js";

export { API_PREFIX } from "../config/services.js";

export interface RouterDependencies {
  checkReadiness?: ReadinessCheck;
}

/**
 * The gateway's own endpoints. Everything else under the API prefix belongs to
 * an upstream and is handled by the proxies mounted in `app.ts` — see the note
 * there on why those cannot live behind a router mount path.
 */
export function createApiRouter({ checkReadiness }: RouterDependencies): Router {
  const router = Router();

  router.use("/health", createHealthRouter(checkReadiness));

  return router;
}
