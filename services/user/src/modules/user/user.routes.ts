import { Router } from "express";
import { validate } from "../../middlewares/validate.js";
import { asyncHandler } from "../../utils/async-handler.js";
import type { UserController } from "./user.controller.js";
import {
  authUserIdParamsSchema,
  createUserSchema,
  updateUserSchema,
  userIdParamsSchema,
} from "./user.schema.js";

export function createUserRouter(controller: UserController): Router {
  const router = Router();

  router.post("/", validate({ body: createUserSchema }), asyncHandler(controller.create));

  // Two segments, so it cannot be shadowed by `/:id` below.
  router.get(
    "/auth/:authUserId",
    validate({ params: authUserIdParamsSchema }),
    asyncHandler(controller.getByAuthUserId),
  );

  router.get(
    "/:id",
    validate({ params: userIdParamsSchema }),
    asyncHandler(controller.getById),
  );

  router.patch(
    "/:id",
    validate({ params: userIdParamsSchema, body: updateUserSchema }),
    asyncHandler(controller.update),
  );

  router.delete(
    "/:id",
    validate({ params: userIdParamsSchema }),
    asyncHandler(controller.remove),
  );

  return router;
}
