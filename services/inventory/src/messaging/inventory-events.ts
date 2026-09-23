import { z } from "zod";
import { bulkReleaseStockSchema } from "../modules/inventory/inventory.schema.js";
import type { MessagingTopology } from "./types.js";

/**
 * The stock-event contract, as this service consumes it.
 *
 * This is the same contract the cart service publishes against — see
 * `services/cart/src/inventory/inventory.messages.ts`. The two files are kept
 * in step by hand rather than shared as a package, which is the repo's
 * convention for cross-service contracts: each side depends only on the
 * fields it names, and a change ships to both. The *topology* half must be
 * identical to the character, since both sides declare it on the broker.
 */

/** Topic exchange every stock transition is published to. */
export const INVENTORY_EXCHANGE = "inventory";

/**
 * Where rejected deliveries go. A fanout, so a dead-lettered message keeps
 * its original routing key and still lands regardless of what it was.
 */
export const INVENTORY_DEAD_LETTER_EXCHANGE = "inventory.dlx";

/** The queue this service consumes; bound to every `inventory.stock.*` key. */
export const INVENTORY_STOCK_QUEUE = "inventory.stock";

/**
 * Where a message that can never succeed ends up — malformed, an unknown
 * type, or a release inventory refused. Nothing consumes it; it is there to
 * be read by a person, and shovelled back once whatever was wrong is fixed.
 */
export const INVENTORY_STOCK_DEAD_QUEUE = "inventory.stock.dead";

export const INVENTORY_STOCK_PATTERN = "inventory.stock.*";

export const InventoryRoutingKey = {
  /** Published by the cart when a cart expires, is abandoned, or checkout fails. */
  release: "inventory.stock.release",
  /** To be published by the order service once payment settles. */
  fulfil: "inventory.stock.fulfil",
  /** To be published by the order service on a refund. */
  return: "inventory.stock.return",
} as const;

export type InventoryRoutingKeyValue =
  (typeof InventoryRoutingKey)[keyof typeof InventoryRoutingKey];

export const INVENTORY_TOPOLOGY: MessagingTopology = {
  exchanges: [
    { name: INVENTORY_EXCHANGE, type: "topic", options: { durable: true } },
    { name: INVENTORY_DEAD_LETTER_EXCHANGE, type: "fanout", options: { durable: true } },
  ],
  queues: [
    {
      name: INVENTORY_STOCK_QUEUE,
      options: { durable: true, deadLetterExchange: INVENTORY_DEAD_LETTER_EXCHANGE },
    },
    { name: INVENTORY_STOCK_DEAD_QUEUE, options: { durable: true } },
  ],
  bindings: [
    { queue: INVENTORY_STOCK_QUEUE, exchange: INVENTORY_EXCHANGE, pattern: INVENTORY_STOCK_PATTERN },
    { queue: INVENTORY_STOCK_DEAD_QUEUE, exchange: INVENTORY_DEAD_LETTER_EXCHANGE, pattern: "" },
  ],
};

/**
 * The envelope every stock event carries.
 *
 * `messageId` is the dedupe key; it is what `processed_messages` is keyed on.
 * The payload is validated with the *same* schema as the HTTP bulk endpoints,
 * so a message can do exactly what a request can and nothing more. Unknown
 * envelope fields are tolerated so the publisher can add some without a
 * lockstep deploy; unknown payload fields are not, for the same reason the
 * HTTP body is strict.
 */
export const stockEventSchema = z.object({
  messageId: z.string().trim().min(1).max(120),
  type: z.enum([
    InventoryRoutingKey.release,
    InventoryRoutingKey.fulfil,
    InventoryRoutingKey.return,
  ]),
  occurredAt: z.iso.datetime(),
  /** The `x-request-id` of whatever caused this, carried across the hop. */
  correlationId: z.string().trim().min(1).max(200).optional(),
  /** Who to attribute the change to, as `x-actor-id` does over HTTP. */
  actor: z.string().trim().min(1).max(120).optional(),
  payload: bulkReleaseStockSchema,
});

export type StockEvent = z.infer<typeof stockEventSchema>;
