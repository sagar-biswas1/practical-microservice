import { Router } from "express";
import { createHealthRouter, type ReadinessCheck } from "../modules/health/health.routes.js";
import { EmailController } from "../modules/email/email.controller.js";
import { createEmailRouter } from "../modules/email/email.routes.js";
import type { EmailDispatcher } from "../modules/email/email.dispatcher.js";
import type { EmailService } from "../modules/email/email.service.js";

export interface RouterDependencies {
  emailService: EmailService;
  /**
   * Optional. When present, `POST /emails/dispatch` is exposed so a cycle can
   * be driven on demand — by an external scheduler when the background loop is
   * turned off, or by hand in development.
   */
  dispatcher?: EmailDispatcher;
  checkReadiness?: ReadinessCheck;
}

export const API_PREFIX = "/api/v1";

export function createApiRouter({
  emailService,
  dispatcher,
  checkReadiness,
}: RouterDependencies): Router {
  const router = Router();

  router.use("/health", createHealthRouter(checkReadiness));
  router.use(
    "/emails",
    createEmailRouter(new EmailController(emailService, dispatcher), {
      withDispatchEndpoint: dispatcher !== undefined,
    }),
  );

  return router;
}
