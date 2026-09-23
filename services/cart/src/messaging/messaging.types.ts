import type { Options } from 'amqplib';

/**
 * Exchange types RabbitMQ ships with. Narrowed from amqplib's `string`
 * escape hatch so a typo is a compile error rather than a channel-closing
 * `COMMAND_INVALID` at boot.
 */
export type ExchangeType = 'topic' | 'direct' | 'fanout' | 'headers';

export interface ExchangeSpec {
  name: string;
  type: ExchangeType;
  /** Merged over `{ durable: true }`; pass `durable: false` to opt out. */
  options?: Options.AssertExchange;
}

export interface QueueSpec {
  name: string;
  /** Merged over `{ durable: true }`; pass `durable: false` to opt out. */
  options?: Options.AssertQueue;
}

export interface BindingSpec {
  queue: string;
  exchange: string;
  /** Routing key, or a pattern such as `inventory.stock.*` on a topic exchange. */
  pattern: string;
}

/**
 * Everything a publisher needs to exist on the broker before its first
 * message. Declared with idempotent `assert*` calls, so declaring the same
 * topology from several services — or from a publisher and its consumer —
 * is harmless as long as they agree on the options. They *must* agree:
 * RabbitMQ answers a mismatched redeclaration with `PRECONDITION_FAILED`
 * and closes the channel, which is why each topology lives in exactly one
 * shared contract file and both sides import it.
 */
export interface MessagingTopology {
  exchanges?: ExchangeSpec[];
  queues?: QueueSpec[];
  bindings?: BindingSpec[];
}

/** What readiness reports about the broker connection. */
export interface BrokerStatus {
  /** False when `RABBITMQ_URL` is unset and nothing here talks to a broker. */
  enabled: boolean;
  connected: boolean;
  /** `host:port/vhost`, credentials stripped, for telling brokers apart in logs. */
  broker?: string;
}

/**
 * The message did not get anywhere: no connection within the deadline, the
 * broker nacked it, or no confirm arrived in time. The one error a caller
 * needs to recognise, because it means "retry later" — the same thing a
 * `ServiceUnavailableException` means on the HTTP path.
 */
export class BrokerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerUnavailableError';
  }
}
