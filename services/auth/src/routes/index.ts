import { Router } from "express";
import { createHealthRouter, type ReadinessCheck } from "../modules/health/health.routes.js";
import { AuthController } from "../modules/auth/auth.controller.js";
import { createAuthRouter } from "../modules/auth/auth.routes.js";
import type { AuthService } from "../modules/auth/auth.service.js";

export interface RouterDependencies {
  authService: AuthService;
  checkReadiness?: ReadinessCheck;
}

export const API_PREFIX = "/api/v1";

export function createApiRouter({ authService, checkReadiness }: RouterDependencies): Router {
  const router = Router();

  router.use("/health", createHealthRouter(checkReadiness));
  router.use("/auth", createAuthRouter(new AuthController(authService)));

  return router;
}
