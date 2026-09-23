import { EventEmitter } from "node:events";
import type { Channel, ChannelModel, ConsumeMessage, Options } from "amqplib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../src/lib/logger.js";
import {
  RabbitMqConsumer,
  type RabbitMqConsumerOptions,
} from "../../src/messaging/rabbitmq.consumer.js";
import type { ConsumeOutcome, MessagingTopology } from "../../src/messaging/types.js";

type OnMessage = (message: ConsumeMessage | null) => void;

/**
 * A fake channel that records declarations and settlements and lets the test
 * deliver messages by hand.
 */
class FakeChannel extends EventEmitter {
  readonly declarations: string[] = [];
  readonly settled: Array<{ kind: "ack" | "nack"; tag: number; requeue?: boolean }> = [];
  prefetchCount: number | null = null;
  consumeOptions: Options.Consume | null = null;
  onMessage: OnMessage | null = null;
  cancelled = false;

  prefetch(count: number) {
    this.prefetchCount = count;
    return Promise.resolve({});
  }
  assertExchange(name: string, type: string, options: Options.AssertExchange) {
    this.declarations.push(`exchange ${name} ${type} ${JSON.stringify(options)}`);
    return Promise.resolve({ exchange: name });
  }
  assertQueue(name: string, options: Options.AssertQueue) {
    this.declarations.push(`queue ${name} ${JSON.stringify(options)}`);
    return Promise.resolve({ queue: name, messageCount: 0, consumerCount: 0 });
  }
  bindQueue(queue: string, exchange: string, pattern: string) {
    this.declarations.push(`bind ${queue} <- ${exchange} ${JSON.stringify(pattern)}`);
    return Promise.resolve({});
  }
  consume(_queue: string, onMessage: OnMessage, options: Options.Consume) {
    this.onMessage = onMessage;
    this.consumeOptions = options;
    return Promise.resolve({ consumerTag: "ctag-1" });
  }
  cancel() {
    this.cancelled = true;
    return Promise.resolve({});
  }
  ack(message: ConsumeMessage) {
    this.settled.push({ kind: "ack", tag: message.fields.deliveryTag });
  }
  nack(message: ConsumeMessage, _allUpTo: boolean, requeue: boolean) {
    this.settled.push({ kind: "nack", tag: message.fields.deliveryTag, requeue });
  }
  close() {
    this.emit("close");
    return Promise.resolve();
  }

  /** Hands a delivery to the consumer callback, as the broker would. */
  deliver(tag: number, body = "{}"): ConsumeMessage {
    const message = {
      content: Buffer.from(body),
      fields: { deliveryTag: tag, redelivered: false, routingKey: "k", exchange: "x", consumerTag: "ctag-1" },
      properties: { messageId: `m-${tag}` },
    } as unknown as ConsumeMessage;
    this.onMessage?.(message);
    return message;
  }
}

class FakeConnection extends EventEmitter {
  readonly channels: FakeChannel[] = [];
  closed = false;

  createChannel(): Promise<Channel> {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return Promise.resolve(channel as unknown as Channel);
  }
  close(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("already closed"));
    this.closed = true;
    for (const channel of this.channels) channel.emit("close");
    this.emit("close");
    return Promise.resolve();
  }
  /** The socket dropped. */
  drop(error = new Error("Connection reset")): void {
    this.closed = true;
    for (const channel of this.channels) channel.emit("close");
    this.emit("error", error);
    this.emit("close", error);
  }
}

function fakeBroker() {
  const connections: FakeConnection[] = [];
  const urls: string[] = [];
  const connectImpl = (url: string): Promise<ChannelModel> => {
    urls.push(url);
    const connection = new FakeConnection();
    connections.push(connection);
    return Promise.resolve(connection as unknown as ChannelModel);
  };
  const connect = vi.fn(connectImpl);
  return {
    connect,
    connectImpl,
    connections,
    urls,
    latest: () => connections.at(-1)!,
    channel: () => connections.at(-1)!.channels[0]!,
  };
}

const TOPOLOGY: MessagingTopology = {
  exchanges: [{ name: "inventory", type: "topic" }],
  queues: [{ name: "inventory.stock", options: { deadLetterExchange: "inventory.dlx" } }],
  bindings: [{ queue: "inventory.stock", exchange: "inventory", pattern: "inventory.stock.*" }],
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await sleep(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function build(
  broker: ReturnType<typeof fakeBroker>,
  handler: (message: ConsumeMessage) => Promise<ConsumeOutcome>,
  overrides: Partial<RabbitMqConsumerOptions> = {},
): RabbitMqConsumer {
  return new RabbitMqConsumer({
    url: "amqp://guest:guest@localhost:5672/shop",
    queue: "inventory.stock",
    topology: TOPOLOGY,
    handler,
    logger,
    connectionName: "inventory-service:consumer",
    prefetch: 7,
    heartbeatSeconds: 30,
    connectTimeoutMs: 1_000,
    maxRetryDelayMs: 10,
    requeueDelayMs: 5,
    connect: broker.connect,
    ...overrides,
  });
}

describe("RabbitMqConsumer", () => {
  let consumer: RabbitMqConsumer | null = null;

  afterEach(async () => {
    await consumer?.stop();
    consumer = null;
  });

  describe("start", () => {
    it("connects, sets prefetch, declares topology, then consumes with manual acks", async () => {
      const broker = fakeBroker();
      consumer = build(broker, async () => "ack");

      await consumer.start();

      expect(broker.urls[0]).toBe("amqp://guest:guest@localhost:5672/shop?heartbeat=30");
      expect(broker.connect).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          timeout: 1_000,
          clientProperties: { connection_name: "inventory-service:consumer" },
        }),
      );

      const channel = broker.channel();
      expect(channel.prefetchCount).toBe(7);
      expect(channel.declarations).toEqual([
        'exchange inventory topic {"durable":true}',
        'queue inventory.stock {"durable":true,"deadLetterExchange":"inventory.dlx"}',
        'bind inventory.stock <- inventory "inventory.stock.*"',
      ]);
      expect(channel.consumeOptions).toEqual({ noAck: false });
      expect(consumer.status()).toEqual({
        enabled: true,
        connected: true,
        broker: "localhost:5672/shop",
        queue: "inventory.stock",
        inFlight: 0,
      });
    });

    it("fails the boot when the broker refuses the first connection", async () => {
      const broker = fakeBroker();
      broker.connect.mockImplementationOnce(() => Promise.reject(new Error("ECONNREFUSED")));
      consumer = build(broker, async () => "ack");

      await expect(consumer.start()).rejects.toThrow("ECONNREFUSED");
      await sleep(30);
      // No reconnect loop was started for a boot-time failure.
      expect(broker.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe("settling deliveries", () => {
    it("acks on 'ack'", async () => {
      const broker = fakeBroker();
      consumer = build(broker, async () => "ack");
      await consumer.start();

      broker.channel().deliver(1);
      await until(() => broker.channel().settled.length === 1, "ack");

      expect(broker.channel().settled).toEqual([{ kind: "ack", tag: 1 }]);
    });

    it("dead-letters on 'reject' (nack, no requeue)", async () => {
      const broker = fakeBroker();
      consumer = build(broker, async () => "reject");
      await consumer.start();

      broker.channel().deliver(2);
      await until(() => broker.channel().settled.length === 1, "nack");

      expect(broker.channel().settled).toEqual([{ kind: "nack", tag: 2, requeue: false }]);
    });

    it("requeues on 'requeue', after the configured pause", async () => {
      const broker = fakeBroker();
      consumer = build(broker, async () => "requeue", { requeueDelayMs: 40 });
      await consumer.start();

      broker.channel().deliver(3);
      await sleep(15);
      expect(broker.channel().settled).toHaveLength(0);
      await until(() => broker.channel().settled.length === 1, "delayed nack");

      expect(broker.channel().settled).toEqual([{ kind: "nack", tag: 3, requeue: true }]);
    });

    it("treats a handler that throws as 'requeue'", async () => {
      const broker = fakeBroker();
      consumer = build(broker, async () => {
        throw new Error("unexpected");
      });
      await consumer.start();

      broker.channel().deliver(4);
      await until(() => broker.channel().settled.length === 1, "nack");

      expect(broker.channel().settled).toEqual([{ kind: "nack", tag: 4, requeue: true }]);
    });

    it("hands the delivery to the handler untouched", async () => {
      const broker = fakeBroker();
      const seen: ConsumeMessage[] = [];
      consumer = build(broker, async (message) => {
        seen.push(message);
        return "ack";
      });
      await consumer.start();

      const message = broker.channel().deliver(5, '{"hello":"world"}');
      await until(() => seen.length === 1, "handler");

      expect(seen[0]).toBe(message);
      expect(seen[0]?.content.toString()).toBe('{"hello":"world"}');
    });

    it("does not settle on a newer channel when the delivery's channel is gone", async () => {
      const broker = fakeBroker();
      let release!: () => void;
      consumer = build(broker, () => new Promise<ConsumeOutcome>((resolve) => {
        release = () => resolve("ack");
      }));
      await consumer.start();
      const first = broker.latest();
      const firstChannel = broker.channel();

      firstChannel.deliver(6);
      await tick();
      expect(consumer.status().inFlight).toBe(1);

      // The broker drops the connection while the handler is still running;
      // it has already requeued the unacked delivery on its side.
      first.drop();
      await until(() => broker.connections.length === 2 && consumer!.connected, "reconnect");

      release();
      await until(() => consumer!.status().inFlight === 0, "handler to settle");

      expect(firstChannel.settled).toHaveLength(0);
      expect(broker.channel().settled).toHaveLength(0);
    });
  });

  describe("recovery", () => {
    it("reconnects after the connection drops, re-declaring topology and consuming again", async () => {
      const broker = fakeBroker();
      consumer = build(broker, async () => "ack");
      await consumer.start();

      broker.connect
        .mockImplementationOnce(() => Promise.reject(new Error("ECONNREFUSED")))
        .mockImplementation(broker.connectImpl);
      broker.latest().drop();
      expect(consumer.connected).toBe(false);

      await until(() => broker.connections.length === 2 && consumer!.connected, "reconnect");

      expect(broker.connect).toHaveBeenCalledTimes(3);
      const fresh = broker.channel();
      expect(fresh.declarations).toHaveLength(3);
      expect(fresh.onMessage).not.toBeNull();

      fresh.deliver(7);
      await until(() => fresh.settled.length === 1, "ack on new channel");
    });

    it("rebuilds the connection when the broker cancels the consumer", async () => {
      const broker = fakeBroker();
      consumer = build(broker, async () => "ack");
      await consumer.start();
      const first = broker.latest();

      // amqplib signals a server-side cancel (e.g. queue deleted) with null.
      broker.channel().onMessage?.(null);

      await until(() => first.closed, "connection dropped");
      await until(() => broker.connections.length === 2 && consumer!.connected, "reconnect");
    });

    it("rebuilds when just the channel closes under a live connection", async () => {
      const broker = fakeBroker();
      consumer = build(broker, async () => "ack");
      await consumer.start();
      const first = broker.latest();

      broker.channel().emit("close");

      await until(() => first.closed, "connection dropped");
      await until(() => broker.connections.length === 2 && consumer!.connected, "reconnect");
    });
  });

  describe("stop", () => {
    it("cancels the consumer, waits for in-flight handlers, then closes and stays closed", async () => {
      const broker = fakeBroker();
      let release!: () => void;
      consumer = build(broker, () => new Promise<ConsumeOutcome>((resolve) => {
        release = () => resolve("ack");
      }));
      await consumer.start();
      const channel = broker.channel();

      channel.deliver(8);
      await tick();

      const stopping = consumer.stop();
      await tick();
      expect(channel.cancelled).toBe(true);
      expect(broker.latest().closed).toBe(false);

      release();
      await stopping;

      // The handler's ack landed before the connection went away.
      expect(channel.settled).toEqual([{ kind: "ack", tag: 8 }]);
      expect(broker.latest().closed).toBe(true);
      expect(consumer.connected).toBe(false);

      await sleep(30);
      expect(broker.connect).toHaveBeenCalledTimes(1);
    });

    it("stops a consumer that is mid-reconnect without reconnecting again", async () => {
      const broker = fakeBroker();
      consumer = build(broker, async () => "ack");
      await consumer.start();

      broker.connect.mockImplementation(() => Promise.reject(new Error("ECONNREFUSED")));
      broker.latest().drop();
      await sleep(15);

      await consumer.stop();
      const attempts = broker.connect.mock.calls.length;
      await sleep(40);
      expect(broker.connect.mock.calls.length).toBe(attempts);
    });
  });
});
