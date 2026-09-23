import type { ConsumeMessage } from "amqplib";
import { DuplicateOperationError, isAppError } from "../../errors/app-error.js";
import type { Logger } from "../../lib/logger.js";
import {
  InventoryRoutingKey,
  stockEventSchema,
  type StockEvent,
} from "../../messaging/inventory-events.js";
import type { ConsumeOutcome } from "../../messaging/types.js";
import type { InventoryService } from "./inventory.service.js";

/**
 * Turns stock events from the broker into the same service calls the HTTP
 * endpoints make. The transport-facing half of the inventory module, as the
 * controller is the HTTP-facing half: both validate, call the service, and
 * report the outcome, and neither knows anything about stock.
 *
 * The outcomes map onto what the HTTP path would have answered:
 *
 * - 2xx → `ack`.
 * - 409 for a *duplicate* (`DuplicateOperationError`) → `ack`. Already done;
 *   redelivery is normal, not exceptional.
 * - Any other 4xx-shaped refusal — malformed body, unknown type, a release
 *   inventory would have answered 409 to → `reject`. Retrying cannot change
 *   the answer, and dropping it silently would hide a real discrepancy, so
 *   it goes to the dead-letter queue for someone to look at.
 * - Anything else — the database, a serialization failure, a bug → `requeue`.
 *   The cart deleted its record when the broker confirmed this message, so
 *   the queue is now the only place the release exists; it must not be lost.
 */
export class StockEventConsumer {
  private readonly log: Logger;

  constructor(
    private readonly service: InventoryService,
    logger: Logger,
  ) {
    this.log = logger.child({ component: "stock-event-consumer" });
  }

  async handle(message: ConsumeMessage): Promise<ConsumeOutcome> {
    const event = this.parse(message);
    if (!event) return "reject";

    const log = this.log.child({
      messageId: event.messageId,
      type: event.type,
      reference: event.payload.reference,
      ...(event.correlationId ? { requestId: event.correlationId } : {}),
      ...(event.actor ? { actor: event.actor } : {}),
      redelivered: message.fields.redelivered,
    });

    switch (event.type) {
      case InventoryRoutingKey.release:
        return this.release(event, log);
      case InventoryRoutingKey.fulfil:
      case InventoryRoutingKey.return:
        // Named in the contract for the order service to publish, but no
        // bulk fulfilment or return exists on the service yet. Dead-lettered
        // rather than acked so the day one arrives it is not lost quietly.
        log.warn("stock_event_unsupported");
        return "reject";
    }
  }

  private async release(event: StockEvent, log: Logger): Promise<ConsumeOutcome> {
    try {
      const items = await this.service.releaseMany(event.payload, {
        idempotencyKey: {
          messageId: event.messageId,
          type: event.type,
          reference: event.payload.reference,
        },
      });
      log.info({ lines: items.length }, "stock_bulk_released");
      return "ack";
    } catch (error) {
      if (error instanceof DuplicateOperationError) {
        log.info("stock_event_duplicate");
        return "ack";
      }
      if (isAppError(error)) {
        // A refusal the HTTP endpoint would have returned as a 4xx. The most
        // likely one is a 409: releasing units that are not held, which is
        // the signature of a release that already landed some other way.
        log.warn(
          { code: error.code, details: error.details ?? null, message: error.message },
          "stock_event_rejected",
        );
        return "reject";
      }
      log.error({ err: error }, "stock_event_failed");
      return "requeue";
    }
  }

  private parse(message: ConsumeMessage): StockEvent | null {
    let raw: unknown;
    try {
      raw = JSON.parse(message.content.toString("utf8"));
    } catch (error) {
      this.log.warn(
        { messageId: message.properties.messageId as unknown, err: error },
        "stock_event_malformed",
      );
      return null;
    }

    const parsed = stockEventSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn(
        {
          messageId: message.properties.messageId as unknown,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        "stock_event_invalid",
      );
      return null;
    }

    return parsed.data;
  }
}
