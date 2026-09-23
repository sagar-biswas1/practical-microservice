import amqp from "amqplib";
import type { Channel, ChannelModel, ConsumeMessage, SocketOptions } from "amqplib";
import type { Logger } from "../lib/logger.js";
import { connectionUrl, describeBroker } from "./broker-url.js";
import type { BrokerStatus, ConsumeOutcome, MessagingTopology } from "./types.js";

export type AmqpConnect = (url: string, socketOptions?: SocketOptions) => Promise<ChannelModel>;

/** Decides what happens to one delivery. Must not throw; a throw is treated as `requeue`. */
export type MessageHandler = (message: ConsumeMessage) => Promise<ConsumeOutcome>;

export interface RabbitMqConsumerOptions {
  url: string;
  queue: string;
  topology: MessagingTopology;
  handler: MessageHandler;
  logger: Logger;
  /** Shown in the management UI's connection list. */
  connectionName: string;
  /** Unacked deliveries the broker may hand this consumer at once. */
  prefetch: number;
  heartbeatSeconds: number;
  connectTimeoutMs: number;
  /** Cap on the backoff between reconnect attempts. */
  maxRetryDelayMs: number;
  /** Pause before a `requeue` goes back, so a down database is not spun on. */
  requeueDelayMs: number;
  /** Test seam; defaults to amqplib's `connect`. */
  connect?: AmqpConnect;
}

/**
 * - `idle`: constructed, `start()` not yet called.
 * - `connected`: consuming.
 * - `disconnected`: lost the broker; a reconnect is or will be scheduled.
 * - `stopped`: `stop()` was called. Terminal.
 */
type State = "idle" | "connected" | "disconnected" | "stopped";

/** How long `stop()` waits for handlers already running before closing anyway. */
const STOP_DRAIN_TIMEOUT_MS = 5_000;

/**
 * One queue, one connection, one channel, one consumer — and everything that
 * has to be true around a handler for at-least-once delivery to be safe:
 *
 * - Manual acks only. A delivery is acked when its handler says so, never
 *   before, so a crash mid-handler returns the message to the queue.
 * - Prefetch bounds how many deliveries are in flight, which is also what
 *   bounds the damage of a hot requeue loop.
 * - `reject` dead-letters (nack without requeue); the queue's
 *   `x-dead-letter-exchange` does the rest. `requeue` waits a beat first.
 * - A settle is only sent on the channel the delivery arrived on. If that
 *   channel is gone the broker has already requeued everything unacked on
 *   it, and acking on a new channel would be an error.
 *
 * The first connection is allowed to fail the process — a bad URL surfaces
 * at boot. Every later loss reconnects forever with a capped backoff,
 * re-declaring topology and re-subscribing each time.
 */
export class RabbitMqConsumer {
  private readonly connect: AmqpConnect;
  private readonly log: Logger;

  private state: State = "idle";
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private consumerTag: string | null = null;
  private inFlight = 0;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private onDrained: (() => void) | null = null;

  constructor(private readonly options: RabbitMqConsumerOptions) {
    this.connect =
      options.connect ?? ((url, socketOptions) => amqp.connect(url, socketOptions));
    this.log = options.logger.child({
      component: "rabbitmq-consumer",
      queue: options.queue,
      broker: describeBroker(options.url),
    });
  }

  get connected(): boolean {
    return this.state === "connected" && this.channel !== null;
  }

  status(): BrokerStatus {
    return {
      enabled: true,
      connected: this.connected,
      broker: describeBroker(this.options.url),
      queue: this.options.queue,
      inFlight: this.inFlight,
    };
  }

  /** The boot-time connection. Throws if it fails, so the process can refuse to start. */
  async start(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`RabbitMqConsumer cannot start from state '${this.state}'`);
    }
    await this.open();
  }

  /**
   * Stops taking deliveries, lets handlers already running settle so their
   * acks land, then closes. Anything still unacked when the connection
   * closes is requeued by the broker — that is the at-least-once guarantee
   * doing its job, not a loss.
   */
  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopped";

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const { connection, channel, consumerTag } = this;
    if (channel && consumerTag) {
      try {
        await channel.cancel(consumerTag);
      } catch (error) {
        this.log.warn({ err: error }, "broker_consumer_cancel_failed");
      }
    }

    await this.waitForDrain(STOP_DRAIN_TIMEOUT_MS);

    this.connection = null;
    this.channel = null;
    this.consumerTag = null;
    if (connection) await closeQuietly(connection);
    this.log.info("broker_consumer_stopped");
  }

  private async open(): Promise<void> {
    const connection = await this.connect(
      connectionUrl(this.options.url, this.options.heartbeatSeconds),
      {
        timeout: this.options.connectTimeoutMs,
        clientProperties: { connection_name: this.options.connectionName },
      },
    );

    // Listeners first. Without an 'error' listener amqplib re-emits a
    // connection failure as an unhandled event; and 'close' has to be seen
    // even if nothing below succeeds. Both ignore a connection that is not
    // (or no longer) the adopted one.
    connection.on("error", (error: Error) =>
      this.log.error({ err: error }, "broker_connection_error"),
    );
    connection.on("close", (error?: Error) => this.onConnectionClosed(connection, error));
    connection.on("blocked", (reason: string) =>
      this.log.warn({ reason }, "broker_connection_blocked"),
    );
    connection.on("unblocked", () => this.log.info("broker_connection_unblocked"));

    let channel: Channel;
    let consumerTag: string;
    try {
      channel = await connection.createChannel();
      channel.on("error", (error: Error) => this.log.error({ err: error }, "broker_channel_error"));
      await channel.prefetch(this.options.prefetch);
      await declare(channel, this.options.topology);

      if (this.state === "stopped") {
        // stop() raced a reconnect. Do not adopt the connection.
        await closeQuietly(connection);
        return;
      }

      // Adopted before `consume` so a delivery that arrives immediately
      // finds the channel it has to be settled on.
      this.connection = connection;
      this.channel = channel;

      const reply = await channel.consume(
        this.options.queue,
        (message) => this.onDelivery(connection, channel, message),
        { noAck: false },
      );
      consumerTag = reply.consumerTag;
    } catch (error) {
      this.connection = null;
      this.channel = null;
      await closeQuietly(connection);
      throw error;
    }

    channel.on("close", () => this.onChannelClosed(connection, channel));

    this.consumerTag = consumerTag;
    this.state = "connected";
    this.attempts = 0;
    this.log.info({ prefetch: this.options.prefetch }, "broker_consumer_started");
  }

  private onDelivery(
    connection: ChannelModel,
    channel: Channel,
    message: ConsumeMessage | null,
  ): void {
    if (message === null) {
      // The broker cancelled the consumer — the queue was deleted under it.
      // Take the one recovery path: drop the connection and rebuild.
      this.log.warn("broker_consumer_cancelled_by_server");
      if (this.channel === channel) void closeQuietly(connection);
      return;
    }

    this.inFlight += 1;
    void this.process(channel, message).finally(() => {
      this.inFlight -= 1;
      if (this.inFlight === 0) this.onDrained?.();
    });
  }

  private async process(channel: Channel, message: ConsumeMessage): Promise<void> {
    const context = {
      messageId: message.properties.messageId as unknown,
      routingKey: message.fields.routingKey,
      redelivered: message.fields.redelivered,
    };

    let outcome: ConsumeOutcome;
    try {
      outcome = await this.options.handler(message);
    } catch (error) {
      // Handlers are meant to decide for themselves; one that throws has hit
      // something it did not anticipate, which is the definition of transient
      // until proven otherwise.
      this.log.error({ ...context, err: error }, "message_handler_threw");
      outcome = "requeue";
    }

    if (this.channel !== channel) {
      // The delivery's channel is gone, and with it the broker's record of
      // this delivery: it has already been requeued. Settling on a newer
      // channel would be a protocol error.
      this.log.warn({ ...context, outcome }, "message_outcome_dropped_channel_gone");
      return;
    }

    try {
      switch (outcome) {
        case "ack":
          channel.ack(message);
          break;
        case "reject":
          channel.nack(message, false, false);
          break;
        case "requeue":
          await sleep(this.options.requeueDelayMs);
          if (this.channel !== channel) return;
          channel.nack(message, false, true);
          break;
      }
    } catch (error) {
      this.log.error({ ...context, outcome, err: error }, "message_settle_failed");
    }
  }

  private onChannelClosed(connection: ChannelModel, channel: Channel): void {
    if (this.channel !== channel) return;
    this.channel = null;
    this.consumerTag = null;
    if (this.state === "connected") this.state = "disconnected";
    this.log.warn("broker_channel_closed");
    void closeQuietly(connection);
  }

  private onConnectionClosed(connection: ChannelModel, error?: Error): void {
    if (this.connection !== connection) return;
    this.connection = null;
    this.channel = null;
    this.consumerTag = null;
    if (this.state === "stopped") return;

    this.state = "disconnected";
    this.log.warn({ err: error }, "broker_connection_closed");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.state !== "disconnected") return;

    this.attempts += 1;
    const delayMs = Math.min(this.attempts * 500, this.options.maxRetryDelayMs);
    this.log.info({ attempt: this.attempts, delayMs }, "broker_reconnect_scheduled");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delayMs);
  }

  private async reconnect(): Promise<void> {
    if (this.state !== "disconnected") return;
    try {
      await this.open();
    } catch (error) {
      this.log.error({ attempt: this.attempts, err: error }, "broker_reconnect_failed");
      this.scheduleReconnect();
    }
  }

  private waitForDrain(timeoutMs: number): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.onDrained = null;
        this.log.warn({ inFlight: this.inFlight }, "broker_consumer_drain_timed_out");
        resolve();
      }, timeoutMs);
      this.onDrained = () => {
        clearTimeout(timer);
        this.onDrained = null;
        resolve();
      };
    });
  }
}

async function declare(channel: Channel, topology: MessagingTopology): Promise<void> {
  for (const exchange of topology.exchanges ?? []) {
    await channel.assertExchange(exchange.name, exchange.type, {
      durable: true,
      ...exchange.options,
    });
  }
  for (const queue of topology.queues ?? []) {
    await channel.assertQueue(queue.name, { durable: true, ...queue.options });
  }
  for (const binding of topology.bindings ?? []) {
    await channel.bindQueue(binding.queue, binding.exchange, binding.pattern);
  }
}

/** amqplib rejects, or throws synchronously, on closing a connection that is already gone. */
async function closeQuietly(connection: ChannelModel): Promise<void> {
  try {
    await connection.close();
  } catch {
    // Already closed.
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
