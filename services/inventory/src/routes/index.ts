import { Router } from "express";
import {
  createHealthRouter,
  type BrokerStatusCheck,
  type ReadinessCheck,
} from "../modules/health/health.routes.js";
import { InventoryController } from "../modules/inventory/inventory.controller.js";
import { createInventoryRouter } from "../modules/inventory/inventory.routes.js";
import type { InventoryService } from "../modules/inventory/inventory.service.js";

export interface RouterDependencies {
  inventoryService: InventoryService;
  checkReadiness?: ReadinessCheck;
  /** Absent when no broker is configured. */
  brokerStatus?: BrokerStatusCheck;
}

export const API_PREFIX = "/api/v1";

export function createApiRouter({
  inventoryService,
  checkReadiness,
  brokerStatus,
}: RouterDependencies): Router {
  const router = Router();

  router.use("/health", createHealthRouter(checkReadiness, brokerStatus));
  router.use("/inventory", createInventoryRouter(new InventoryController(inventoryService)));

  return router;
}
