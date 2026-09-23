import type { Options } from "amqplib";

export type ExchangeType = "topic" | "direct" | "fanout" | "headers";

export interface ExchangeSpec {
  name: string;
  type: ExchangeType;
  /** Merged over `{ durable: true }`. */
  options?: Options.AssertExchange;
}

export interface QueueSpec {
  name: string;
  /** Merged over `{ durable: true }`. */
  options?: Options.AssertQueue;
}

export interface BindingSpec {
  queue: string;
  exchange: string;
  /** Routing key or pattern; ignored by a fanout exchange but still required. */
  pattern: string;
}

/**
 * Everything that has to exist on the broker before a message can be
 * consumed. Declared with idempotent `assert*` calls, so the publisher and
 * the consumer both declaring it is harmless — as long as they agree. They
 * *must*: RabbitMQ answers a redeclaration with different options with
 * PRECONDITION_FAILED and closes the channel.
 */
export interface MessagingTopology {
  exchanges?: ExchangeSpec[];
  queues?: QueueSpec[];
  bindings?: BindingSpec[];
}

/**
 * What a handler tells the consumer to do with a delivery.
 *
 * - `ack`: done, or a duplicate of something already done.
 * - `reject`: this message will never succeed — malformed, unknown type, or a
 *   domain refusal. Dead-lettered for a human, not retried.
 * - `requeue`: something transient stood in the way — the database, a
 *   serialization failure. Returned to the queue after a short delay.
 */
export type ConsumeOutcome = "ack" | "reject" | "requeue";

/** What readiness reports about the broker. */
export interface BrokerStatus {
  /** False when RABBITMQ_URL is unset and no consumer runs. */
  enabled: boolean;
  connected: boolean;
  /** `host:port/vhost`, credentials stripped. */
  broker?: string;
  queue?: string;
  /** Deliveries whose handler has not settled yet. */
  inFlight?: number;
}
