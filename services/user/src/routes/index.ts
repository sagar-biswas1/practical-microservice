import { Router } from "express";
import { createHealthRouter, type ReadinessCheck } from "../modules/health/health.routes.js";
import { UserController } from "../modules/user/user.controller.js";
import { createUserRouter } from "../modules/user/user.routes.js";
import type { UserService } from "../modules/user/user.service.js";

export interface RouterDependencies {
  userService: UserService;
  checkReadiness?: ReadinessCheck;
}

export const API_PREFIX = "/api/v1";

export function createApiRouter({
  userService,
  checkReadiness,
}: RouterDependencies): Router {
  const router = Router();

  router.use("/health", createHealthRouter(checkReadiness));
  router.use("/users", createUserRouter(new UserController(userService)));

  return router;
}
