import { Router } from "express";
import { createHealthRouter, type ReadinessCheck } from "../modules/health/health.routes.js";
import { InventoryController } from "../modules/inventory/inventory.controller.js";
import { createInventoryRouter } from "../modules/inventory/inventory.routes.js";
import type { InventoryService } from "../modules/inventory/inventory.service.js";

export interface RouterDependencies {
  inventoryService: InventoryService;
  checkReadiness?: ReadinessCheck;
}

export const API_PREFIX = "/api/v1";

export function createApiRouter({
  inventoryService,
  checkReadiness,
}: RouterDependencies): Router {
  const router = Router();

  router.use("/health", createHealthRouter(checkReadiness));
  router.use("/inventory", createInventoryRouter(new InventoryController(inventoryService)));

  return router;
}
