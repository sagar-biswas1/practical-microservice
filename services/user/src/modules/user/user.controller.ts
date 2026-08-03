import type { NextFunction, Request, Response } from "express";
import { validated } from "../../middlewares/validate.js";
import { sendCreated, sendNoContent, sendSuccess } from "../../utils/api-response.js";
import type { UserService } from "./user.service.js";
import type {
  AuthUserIdParams,
  CreateUserInput,
  UpdateUserInput,
  UserIdParams,
} from "./user.schema.js";

/**
 * HTTP adapter: reads validated input, delegates to the service, shapes the
 * response. No business logic.
 *
 * This is where the error-first convention meets Express. Each handler
 * destructures `[error, data]` and hands a failure to `next`, which is the
 * framework's own error channel — so the tuple stops here and the global
 * error handler renders it exactly as it renders a thrown one. The gain over
 * `try`/`catch` is that forgetting the check is a type error, not a silent
 * 500 discovered later.
 */
export class UserController {
  constructor(private readonly service: UserService) {}

  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { body } = validated<CreateUserInput>(req);

    const [error, user] = await this.service.create(body);
    if (error) return next(error);

    req.log.info({ userId: user.id, authUserId: user.authUserId }, "user_created");
    sendCreated(res, user);
  };

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { params } = validated<unknown, unknown, UserIdParams>(req);

    const [error, user] = await this.service.getById(params.id);
    if (error) return next(error);

    sendSuccess(res, user);
  };

  getByAuthUserId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { params } = validated<unknown, unknown, AuthUserIdParams>(req);

    const [error, user] = await this.service.getByAuthUserId(params.authUserId);
    if (error) return next(error);

    sendSuccess(res, user);
  };

  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { body, params } = validated<UpdateUserInput, unknown, UserIdParams>(req);

    const [error, user] = await this.service.update(params.id, body);
    if (error) return next(error);

    req.log.info({ userId: user.id }, "user_updated");
    sendSuccess(res, user);
  };

  remove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { params } = validated<unknown, unknown, UserIdParams>(req);

    const [error] = await this.service.remove(params.id);
    if (error) return next(error);

    req.log.info({ userId: params.id }, "user_deleted");
    sendNoContent(res);
  };
}
