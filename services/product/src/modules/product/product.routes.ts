import { Router } from "express";
import { validate } from "../../middlewares/validate.js";
import { asyncHandler } from "../../utils/async-handler.js";
import type { ProductController } from "./product.controller.js";
import {
  createProductSchema,
  listProductsQuerySchema,
  productIdParamsSchema,
  updateProductSchema,
} from "./product.schema.js";

export function createProductRouter(controller: ProductController): Router {
  const router = Router();

  router.get(
    "/",
    validate({ query: listProductsQuerySchema }),
    asyncHandler(controller.list),
  );

  router.post(
    "/",
    validate({ body: createProductSchema }),
    asyncHandler(controller.create),
  );

  router.get(
    "/:id",
    validate({ params: productIdParamsSchema }),
    asyncHandler(controller.getById),
  );

  router.patch(
    "/:id",
    validate({ params: productIdParamsSchema, body: updateProductSchema }),
    asyncHandler(controller.update),
  );

  router.delete(
    "/:id",
    validate({ params: productIdParamsSchema }),
    asyncHandler(controller.remove),
  );

  return router;
}
