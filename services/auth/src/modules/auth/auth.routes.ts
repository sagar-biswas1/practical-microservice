import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { validate } from "../../middlewares/validate.js";
import { asyncHandler } from "../../utils/async-handler.js";
import type { AuthController } from "./auth.controller.js";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginHistoryQuerySchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "./auth.schema.js";

/**
 * The two halves of this router are split deliberately.
 *
 * Everything above `authenticate` is reachable by anyone — those are the
 * endpoints that *establish* identity, so requiring one would be circular.
 * Everything below it has a verified caller on `req.auth`.
 *
 * `POST /logout` and `POST /refresh` sit in the public half on purpose: both
 * are authenticated by the refresh token in the body, and requiring a valid
 * *access* token would make them useless exactly when they are needed — when
 * the access token has expired.
 */
export function createAuthRouter(controller: AuthController): Router {
  const router = Router();

  // ---- Public -----------------------------------------------------------

  router.post("/register", validate({ body: registerSchema }), asyncHandler(controller.register));

  router.post(
    "/verify-email",
    validate({ body: verifyEmailSchema }),
    asyncHandler(controller.verifyEmail),
  );

  router.post(
    "/resend-verification",
    validate({ body: resendVerificationSchema }),
    asyncHandler(controller.resendVerification),
  );

  router.post("/login", validate({ body: loginSchema }), asyncHandler(controller.login));

  router.post("/refresh", validate({ body: refreshSchema }), asyncHandler(controller.refresh));

  router.post("/logout", validate({ body: logoutSchema }), asyncHandler(controller.logout));

  router.post(
    "/forgot-password",
    validate({ body: forgotPasswordSchema }),
    asyncHandler(controller.forgotPassword),
  );

  router.post(
    "/reset-password",
    validate({ body: resetPasswordSchema }),
    asyncHandler(controller.resetPassword),
  );

  // ---- Authenticated ----------------------------------------------------

  // Applies to every route declared below this line, so a new one is protected
  // by default. Adding a public endpoint after this point would be a mistake
  // that fails closed — the wrong direction to fail in is the safe one.
  router.use(authenticate);

  router.get("/me", asyncHandler(controller.me));

  router.post(
    "/change-password",
    validate({ body: changePasswordSchema }),
    asyncHandler(controller.changePassword),
  );

  router.get("/sessions", asyncHandler(controller.sessions));

  router.post("/logout-all", asyncHandler(controller.logoutAll));

  router.get(
    "/login-history",
    validate({ query: loginHistoryQuerySchema }),
    asyncHandler(controller.loginHistory),
  );

  return router;
}
