import { Router } from "express";
import { validate } from "../../middlewares/validate.js";
import { asyncHandler } from "../../utils/async-handler.js";
import type { InventoryController } from "./inventory.controller.js";
import {
  adjustStockSchema,
  createInventoryItemSchema,
  fulfilStockSchema,
  inventoryIdParamsSchema,
  listAuditLogsQuerySchema,
  listInventoryQuerySchema,
  listMovementsQuerySchema,
  receiveStockSchema,
  releaseStockSchema,
  reserveStockSchema,
  returnStockSchema,
  sellStockSchema,
  skuParamsSchema,
  updateInventoryItemSchema,
} from "./inventory.schema.js";

export function createInventoryRouter(controller: InventoryController): Router {
  const router = Router();

  router.get("/", validate({ query: listInventoryQuerySchema }), asyncHandler(controller.list));
  router.post("/", validate({ body: createInventoryItemSchema }), asyncHandler(controller.create));

  // Registered before `/:id` so the literal segment is not shadowed.
  router.get("/sku/:sku", validate({ params: skuParamsSchema }), asyncHandler(controller.getBySku));

  router.get("/:id", validate({ params: inventoryIdParamsSchema }), asyncHandler(controller.getById));
  router.patch(
    "/:id",
    validate({ params: inventoryIdParamsSchema, body: updateInventoryItemSchema }),
    asyncHandler(controller.update),
  );
  router.delete(
    "/:id",
    validate({ params: inventoryIdParamsSchema }),
    asyncHandler(controller.remove),
  );

  router.get(
    "/:id/audit-logs",
    validate({ params: inventoryIdParamsSchema, query: listAuditLogsQuerySchema }),
    asyncHandler(controller.listAuditLogs),
  );

  router.get(
    "/:id/movements",
    validate({ params: inventoryIdParamsSchema, query: listMovementsQuerySchema }),
    asyncHandler(controller.listMovements),
  );

  // Stock transitions are POSTs on sub-resources: each one is a discrete,
  // audited event rather than a PATCH on a mutable counter.
  router.post(
    "/:id/reserve",
    validate({ params: inventoryIdParamsSchema, body: reserveStockSchema }),
    asyncHandler(controller.reserve),
  );
  router.post(
    "/:id/release",
    validate({ params: inventoryIdParamsSchema, body: releaseStockSchema }),
    asyncHandler(controller.release),
  );
  router.post(
    "/:id/fulfil",
    validate({ params: inventoryIdParamsSchema, body: fulfilStockSchema }),
    asyncHandler(controller.fulfil),
  );
  router.post(
    "/:id/sell",
    validate({ params: inventoryIdParamsSchema, body: sellStockSchema }),
    asyncHandler(controller.sell),
  );
  router.post(
    "/:id/return",
    validate({ params: inventoryIdParamsSchema, body: returnStockSchema }),
    asyncHandler(controller.acceptReturn),
  );
  router.post(
    "/:id/receive",
    validate({ params: inventoryIdParamsSchema, body: receiveStockSchema }),
    asyncHandler(controller.receive),
  );
  router.post(
    "/:id/adjust",
    validate({ params: inventoryIdParamsSchema, body: adjustStockSchema }),
    asyncHandler(controller.adjust),
  );

  return router;
}
