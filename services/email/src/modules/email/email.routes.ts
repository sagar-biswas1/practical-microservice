import { Router } from "express";
import { validate } from "../../middlewares/validate.js";
import { asyncHandler } from "../../utils/async-handler.js";
import type { EmailController } from "./email.controller.js";
import {
  emailIdParamsSchema,
  listEmailsQuerySchema,
  sendEmailSchema,
} from "./email.schema.js";

export interface EmailRouterOptions {
  /**
   * Registers `POST /dispatch`. Off unless a dispatcher was wired in, so the
   * endpoint 404s rather than existing in a form that cannot work.
   */
  withDispatchEndpoint?: boolean;
}

export function createEmailRouter(
  controller: EmailController,
  { withDispatchEndpoint = false }: EmailRouterOptions = {},
): Router {
  const router = Router();

  router.post("/", validate({ body: sendEmailSchema }), asyncHandler(controller.send));

  router.get("/", validate({ query: listEmailsQuerySchema }), asyncHandler(controller.list));

  // Literal paths are declared before `/:id`. The id schema would reject
  // `stats` as a non-UUID anyway, but relying on that would make the routing
  // depend on the shape of an identifier that could change.
  router.get("/stats", asyncHandler(controller.stats));

  if (withDispatchEndpoint) {
    router.post("/dispatch", asyncHandler(controller.dispatch));
  }

  router.get("/:id", validate({ params: emailIdParamsSchema }), asyncHandler(controller.getById));

  router.post(
    "/:id/retry",
    validate({ params: emailIdParamsSchema }),
    asyncHandler(controller.retry),
  );

  return router;
}
