import { Router } from "express";
import { createHealthRouter, type ReadinessCheck } from "../modules/health/health.routes.js";
import { ProductController } from "../modules/product/product.controller.js";
import { createProductRouter } from "../modules/product/product.routes.js";
import type { ProductService } from "../modules/product/product.service.js";

export interface RouterDependencies {
  productService: ProductService;
  checkReadiness?: ReadinessCheck;
}

export const API_PREFIX = "/api/v1";

export function createApiRouter({
  productService,
  checkReadiness,
}: RouterDependencies): Router {
  const router = Router();

  router.use("/health", createHealthRouter(checkReadiness));
  router.use("/products", createProductRouter(new ProductController(productService)));

  return router;
}
