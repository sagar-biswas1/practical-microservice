import type { NextFunction, Request, Response } from "express";
import { UnauthorizedError } from "../../errors/app-error.js";
import { validated } from "../../middlewares/validate.js";
import {
  sendCreated,
  sendNoContent,
  sendPaginated,
  sendSuccess,
} from "../../utils/api-response.js";
import type { AuthService, RequestMeta } from "./auth.service.js";
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginHistoryQuery,
  LoginInput,
  LogoutInput,
  RefreshInput,
  RegisterInput,
  ResendVerificationInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from "./auth.schema.js";

/** Browsers send long strings; the column stores a fingerprint, not a document. */
const USER_AGENT_MAX_LENGTH = 512;

/**
 * HTTP adapter: reads validated input, delegates to the service, shapes the
 * response. No business logic.
 *
 * This is where the error-first convention meets Express. Each handler
 * destructures `[error, data]` and hands a failure to `next`, which is the
 * framework's own error channel — so the tuple stops here and the global error
 * handler renders it exactly as it renders a thrown one. The gain over
 * `try`/`catch` is that forgetting the check is a type error, not a silent 500
 * discovered later.
 *
 * One rule is specific to this controller: **nothing logged here may contain a
 * password, a code, or a token.** The log calls below name ids and outcomes
 * only. `lib/logger.ts` redacts the obvious keys as a backstop, but a
 * redaction list is a safety net, not a licence to throw secrets at it.
 */
export class AuthController {
  constructor(private readonly service: AuthService) {}

  register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { body } = validated<RegisterInput>(req);

    const [error, result] = await this.service.register(body, this.meta(req));
    if (error) return next(error);

    if (!result.emailQueued) {
      // Worth a warning rather than an info: the account exists but the user
      // is waiting on mail that was never accepted by the email service.
      req.log.warn(
        { authUserId: result.user.id },
        "registration_verification_email_not_queued",
      );
    }

    req.log.info({ authUserId: result.user.id }, "auth_user_registered");
    sendCreated(res, result);
  };

  verifyEmail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { body } = validated<VerifyEmailInput>(req);

    const [error, result] = await this.service.verifyEmail(body, this.meta(req));
    if (error) return next(error);

    if (!result.profileCreated) {
      // The account is verified and usable; only the user-service profile is
      // missing, and the next login retries it.
      req.log.warn({ authUserId: result.user.id }, "profile_handoff_deferred");
    }

    req.log.info(
      { authUserId: result.user.id, profileCreated: result.profileCreated },
      "auth_user_verified",
    );
    sendSuccess(res, result);
  };

  /**
   * Always 202, whatever happened. The service reports success for an unknown
   * address, an already-verified account and a cooldown alike — see the
   * no-enumeration rule on `AuthService`. Answering differently here would
   * undo that in one line.
   */
  resendVerification = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const { body } = validated<ResendVerificationInput>(req);

    const [error] = await this.service.resendVerification(body.email, this.meta(req));
    if (error) return next(error);

    sendSuccess(
      res,
      { message: "If that address needs verifying, a new code is on its way." },
      202,
    );
  };

  login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { body } = validated<LoginInput>(req);

    const [error, result] = await this.service.login(body, this.meta(req));
    if (error) return next(error);

    req.log.info({ authUserId: result.user.id }, "login_succeeded");
    sendSuccess(res, result);
  };

  refresh = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { body } = validated<RefreshInput>(req);

    const [error, tokens] = await this.service.refresh(body.refreshToken, this.meta(req));
    if (error) return next(error);

    sendSuccess(res, tokens);
  };

  logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { body } = validated<LogoutInput>(req);

    const [error] = await this.service.logout(body.refreshToken);
    if (error) return next(error);

    sendNoContent(res);
  };

  logoutAll = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const [principalError, principal] = this.principal(req);
    if (principalError) return next(principalError);

    const [error, result] = await this.service.logoutAll(principal.authUserId);
    if (error) return next(error);

    req.log.info({ authUserId: principal.authUserId, ...result }, "sessions_revoked");
    sendSuccess(res, result);
  };

  forgotPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { body } = validated<ForgotPasswordInput>(req);

    const [error] = await this.service.forgotPassword(body, this.meta(req));
    if (error) return next(error);

    // Same body, same status, whether or not the account exists.
    sendSuccess(
      res,
      { message: "If that address has an account, a reset code is on its way." },
      202,
    );
  };

  resetPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { body } = validated<ResetPasswordInput>(req);

    const [error] = await this.service.resetPassword(body, this.meta(req));
    if (error) return next(error);

    sendSuccess(res, {
      message: "Password updated. All sessions have been signed out.",
    });
  };

  changePassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const [principalError, principal] = this.principal(req);
    if (principalError) return next(principalError);

    const { body } = validated<ChangePasswordInput>(req);

    const [error, tokens] = await this.service.changePassword(
      principal.authUserId,
      body,
      this.meta(req),
    );
    if (error) return next(error);

    req.log.info({ authUserId: principal.authUserId }, "password_changed");
    // The new pair keeps *this* device signed in; every other one was revoked.
    sendSuccess(res, tokens);
  };

  me = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const [principalError, principal] = this.principal(req);
    if (principalError) return next(principalError);

    const [error, user] = await this.service.getById(principal.authUserId);
    if (error) return next(error);

    sendSuccess(res, user);
  };

  sessions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const [principalError, principal] = this.principal(req);
    if (principalError) return next(principalError);

    const [error, sessions] = await this.service.listSessions(
      principal.authUserId,
      principal.sessionId,
    );
    if (error) return next(error);

    sendSuccess(res, sessions);
  };

  loginHistory = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const [principalError, principal] = this.principal(req);
    if (principalError) return next(principalError);

    const { query } = validated<unknown, LoginHistoryQuery>(req);

    const [error, page] = await this.service.listLoginHistory(principal.authUserId, query);
    if (error) return next(error);

    sendPaginated(res, page.items, {
      page: query.page,
      limit: query.limit,
      total: page.total,
    });
  };

  /**
   * Narrows `req.auth`, which is optional because public routes exist.
   *
   * Reaching a handler that calls this without `authenticate` in front of it is
   * a wiring mistake, not a client error — but it is reported as a 401 anyway,
   * because the alternative is a crash and because leaking "this route is
   * misconfigured" helps an attacker more than it helps anyone else.
   */
  private principal(req: Request): [UnauthorizedError, null] | [null, NonNullable<Request["auth"]>] {
    if (!req.auth) return [new UnauthorizedError("Authentication required"), null];
    return [null, req.auth];
  }

  /**
   * Client details for the audit trail.
   *
   * `req.ip` is only trustworthy because `app.set("trust proxy", true)` is set
   * and this service sits behind the gateway — otherwise `X-Forwarded-For` is
   * a client-supplied string and every row in `login_history` would say
   * whatever the attacker wanted it to.
   */
  private meta(req: Request): RequestMeta {
    return {
      ip: req.ip,
      userAgent: req.get("user-agent")?.slice(0, USER_AGENT_MAX_LENGTH),
      requestId: req.id,
    };
  }
}
