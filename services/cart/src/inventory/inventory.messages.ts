import type { StockLine } from './inventory.types';

/**
 * The wire contract for the fire-and-forget half, written down now so the
 * switch to RabbitMQ is an adapter and a config value rather than a design.
 *
 * Nothing here is used while `INVENTORY_DISPATCH_TRANSPORT` is `http`. It is
 * the specification the AMQP adapter fills in, and the shape the order
 * service should copy when it starts publishing fulfilments and returns.
 */

/**
 * Topic exchange. Topic rather than direct so a consumer can bind to
 * `inventory.stock.*` and pick up transitions added later without a
 * deployment on the publishing side.
 */
export const INVENTORY_EXCHANGE = 'inventory';

/**
 * Routing keys, one per stock transition.
 *
 * Only `release` is published by the cart. The other two are here because the
 * order service publishes them against the same exchange, and a single list
 * is what stops the two services inventing different names for the same
 * event.
 */
export const InventoryRoutingKey = {
  release: 'inventory.stock.release',
  /** Published by the order service once payment settles. */
  fulfil: 'inventory.stock.fulfil',
  /** Published by the order service on a refund. */
  return: 'inventory.stock.return',
} as const;

export type InventoryRoutingKeyValue =
  (typeof InventoryRoutingKey)[keyof typeof InventoryRoutingKey];

/**
 * The envelope every message carries.
 *
 * `messageId` is the part that matters most. Delivery is at-least-once, and
 * inventory's transitions are *not* idempotent — applying a release twice
 * hands back units that were never held, which either raises a conflict or,
 * if another cart has reserved them meanwhile, quietly inflates available
 * stock. The consumer must therefore keep a seen-set keyed on this id and
 * drop repeats. Redelivery after a broker restart or a consumer crash is
 * normal, not exceptional.
 *
 * `correlationId` is the same `x-request-id` the HTTP path propagates, so one
 * id still spans the chain once the hop stops being an HTTP call.
 */
export interface InventoryMessage<TPayload> {
  messageId: string;
  type: InventoryRoutingKeyValue;
  occurredAt: string;
  correlationId?: string | undefined;
  /** Who to attribute the change to, as `x-actor-id` does over HTTP. */
  actor?: string | undefined;
  payload: TPayload;
}

/**
 * `reference` identifies what the units were held for — a cart session or an
 * order id. It is what makes a release traceable on inventory's ledger, and
 * what a reconciliation job matches against to find orphaned holds.
 */
export interface StockChangePayload {
  items: StockLine[];
  reference: string;
  reason?: string | undefined;
}

export type ReleaseStockMessage = InventoryMessage<StockChangePayload>;

/**
 * Publishing options RabbitMQ needs for the message to survive a broker
 * restart: a durable exchange plus `persistent` on each message. Without both
 * an expiry release can be acknowledged and then lost, which is the one
 * failure this whole path exists to prevent.
 */
export const PUBLISH_OPTIONS = {
  persistent: true,
  contentType: 'application/json',
} as const;

/**
 * The routing key a message goes out on. One place, so the publisher and any
 * future binding cannot drift apart.
 */
export function routingKeyFor(message: InventoryMessage<unknown>): string {
  return message.type;
}

export function buildStockChangeMessage(
  type: InventoryRoutingKeyValue,
  payload: StockChangePayload,
  envelope: {
    messageId: string;
    correlationId?: string | undefined;
    actor?: string | undefined;
  },
): InventoryMessage<StockChangePayload> {
  return {
    messageId: envelope.messageId,
    type,
    occurredAt: new Date().toISOString(),
    correlationId: envelope.correlationId,
    actor: envelope.actor,
    payload,
  };
}
