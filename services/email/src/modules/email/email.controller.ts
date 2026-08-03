import type { NextFunction, Request, Response } from "express";
import { validated } from "../../middlewares/validate.js";
import { ValidationError } from "../../errors/app-error.js";
import { zodIssuesToDetails } from "../../errors/normalize.js";
import { sendPaginated, sendSuccess } from "../../utils/api-response.js";
import type { EmailDispatcher } from "./email.dispatcher.js";
import type { EmailService } from "./email.service.js";
import {
  idempotencyKeySchema,
  type EmailIdParams,
  type ListEmailsQuery,
  type SendEmailInput,
} from "./email.schema.js";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
/** Set on a response that replayed an earlier request rather than creating one. */
export const IDEMPOTENT_REPLAY_HEADER = "idempotent-replay";

/**
 * HTTP adapter. Reads validated input, delegates, shapes the response.
 *
 * As in the user service this is where the error-first convention meets
 * Express: each handler destructures `[error, data]` and hands a failure to
 * `next`, so the tuple stops here and the global error handler renders it.
 */
export class EmailController {
  constructor(
    private readonly service: EmailService,
    private readonly dispatcher?: EmailDispatcher,
  ) {}

  /**
   * Accepts a message into the outbox.
   *
   * Answers `202 Accepted`, not `201`: at this point the row is committed and
   * nothing more. The email has not been sent, and claiming otherwise would be
   * a lie the caller might reasonably act on. `GET /emails/:id` is how they
   * find out what happened next.
   */
  send = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { body } = validated<SendEmailInput>(req);

    const [keyError, idempotencyKey] = this.readIdempotencyKey(req);
    if (keyError) return next(keyError);

    const [error, result] = await this.service.enqueue(body, idempotencyKey);
    if (error) return next(error);

    if (result.replayed) {
      res.setHeader(IDEMPOTENT_REPLAY_HEADER, "true");
      req.log.info({ emailId: result.message.id, idempotencyKey }, "email_enqueue_replayed");
      // 200, not 202: nothing was accepted this time round.
      sendSuccess(res, result.message, 200);
      return;
    }

    req.log.info(
      { emailId: result.message.id, source: body.source, recipient: body.recipient },
      "email_enqueued",
    );
    sendSuccess(res, result.message, 202);
  };

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { params } = validated<unknown, unknown, EmailIdParams>(req);

    const [error, message] = await this.service.getById(params.id);
    if (error) return next(error);

    sendSuccess(res, message);
  };

  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { query } = validated<unknown, ListEmailsQuery>(req);

    const [error, page] = await this.service.list(query);
    if (error) return next(error);

    sendPaginated(res, page.items, { page: page.page, limit: page.limit, total: page.total });
  };

  /** Outbox depth by status — what a dashboard or an alert rule watches. */
  stats = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    const [error, counts] = await this.service.stats();
    if (error) return next(error);

    sendSuccess(res, counts);
  };

  retry = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { params } = validated<unknown, unknown, EmailIdParams>(req);

    const [error, message] = await this.service.retry(params.id);
    if (error) return next(error);

    req.log.info({ emailId: message.id }, "email_requeued");
    sendSuccess(res, message, 202);
  };

  /**
   * Runs a single dispatch cycle on demand.
   *
   * Registered only when a dispatcher is wired in. Useful when the background
   * loop is disabled and delivery is driven by an external scheduler, and
   * useful in development for not waiting out the poll interval.
   */
  dispatch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!this.dispatcher) return next(new Error("No dispatcher is configured"));

    const [error, summary] = await this.dispatcher.runOnce();
    if (error) return next(error);

    req.log.info({ ...summary }, "dispatch_cycle_requested");
    sendSuccess(res, summary);
  };

  /**
   * Reads and validates the `Idempotency-Key` header.
   *
   * Optional by design. A caller that omits it gets no replay protection,
   * which is the right default for a one-off `curl` but not for a service
   * that retries on timeout — the API docs say so, and the header is the only
   * thing standing between a network blip and a duplicate email.
   */
  private readIdempotencyKey(req: Request): [ValidationError, null] | [null, string | undefined] {
    const raw = req.get(IDEMPOTENCY_KEY_HEADER);
    if (raw === undefined) return [null, undefined];

    const parsed = idempotencyKeySchema.safeParse(raw);
    if (!parsed.success) {
      return [
        new ValidationError(
          "Invalid Idempotency-Key header",
          zodIssuesToDetails(parsed.error).map((detail) => ({
            ...detail,
            field: "Idempotency-Key",
          })),
        ),
        null,
      ];
    }

    return [null, parsed.data];
  }
}
