import { EventEmitter } from 'node:events';
import type { ChannelModel, ConfirmChannel, Options } from 'amqplib';

import {
  BrokerUnavailableError,
  type MessagingTopology,
} from './messaging.types';
import { RabbitMqClient } from './rabbitmq.client';

// Pinned so the tests are hermetic and the timeouts are short enough to
// wait for. `env` is a plain object here, so a test can flip RABBITMQ_URL.
jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    SERVICE_NAME: 'cart-service',
    RABBITMQ_URL: 'amqp://guest:guest@localhost:5672/shop',
    RABBITMQ_HEARTBEAT_SECONDS: 30,
    RABBITMQ_CONNECT_TIMEOUT_MS: 1_000,
    RABBITMQ_MAX_RETRY_DELAY_MS: 10,
    RABBITMQ_PUBLISH_TIMEOUT_MS: 60,
  },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { env } = require('../config/env') as {
  env: { RABBITMQ_URL: string | undefined };
};

type ConfirmCallback = (err: unknown, ok?: unknown) => void;

interface PublishCall {
  exchange: string;
  routingKey: string;
  content: Buffer;
  options: Options.Publish;
  confirm: ConfirmCallback;
}

/**
 * A fake confirm channel: records declarations and publishes, and leaves the
 * confirm callback to the test, so acks, nacks and silence can each be
 * played out on demand.
 */
class FakeChannel extends EventEmitter {
  readonly declarations: string[] = [];
  readonly publishes: PublishCall[] = [];
  failDeclarationsWith: Error | null = null;

  assertExchange(name: string, type: string, options: Options.AssertExchange) {
    return this.declare(`exchange ${name} ${type} ${JSON.stringify(options)}`);
  }

  assertQueue(name: string, options: Options.AssertQueue) {
    return this.declare(`queue ${name} ${JSON.stringify(options)}`);
  }

  bindQueue(queue: string, exchange: string, pattern: string) {
    return this.declare(`bind ${queue} <- ${exchange} ${pattern}`);
  }

  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish,
    confirm: ConfirmCallback,
  ): boolean {
    this.publishes.push({ exchange, routingKey, content, options, confirm });
    return true;
  }

  close(): Promise<void> {
    this.emit('close');
    return Promise.resolve();
  }

  private declare(what: string): Promise<unknown> {
    if (this.failDeclarationsWith) {
      return Promise.reject(this.failDeclarationsWith);
    }
    this.declarations.push(what);
    return Promise.resolve({});
  }
}

class FakeConnection extends EventEmitter {
  readonly channels: FakeChannel[] = [];
  closed = false;

  createConfirmChannel(): Promise<ConfirmChannel> {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return Promise.resolve(channel as unknown as ConfirmChannel);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('already closed'));
    this.closed = true;
    for (const channel of this.channels) channel.emit('close');
    this.emit('close');
    return Promise.resolve();
  }

  /** The broker went away: what amqplib emits when the socket drops. */
  drop(error = new Error('Connection reset')): void {
    this.closed = true;
    for (const channel of this.channels) channel.emit('close');
    this.emit('error', error);
    this.emit('close', error);
  }
}

/**
 * A fake `amqplib.connect`. Hands out one FakeConnection per call, and can be
 * told to refuse the next N attempts the way a down broker would.
 */
function fakeBroker(refuseFirst = 0) {
  const connections: FakeConnection[] = [];
  const urls: string[] = [];
  let refusals = refuseFirst;

  const connectImpl = (url: string): Promise<ChannelModel> => {
    urls.push(url);
    if (refusals > 0) {
      refusals -= 1;
      return Promise.reject(new Error('ECONNREFUSED'));
    }
    const connection = new FakeConnection();
    connections.push(connection);
    return Promise.resolve(connection as unknown as ChannelModel);
  };
  const connect = jest.fn(connectImpl);

  return {
    connect,
    connectImpl,
    connections,
    urls,
    latest: () => connections.at(-1)!,
  };
}

const TOPOLOGY: MessagingTopology = {
  exchanges: [{ name: 'inventory', type: 'topic' }],
  queues: [{ name: 'inventory.stock' }],
  bindings: [
    {
      queue: 'inventory.stock',
      exchange: 'inventory',
      pattern: 'inventory.stock.*',
    },
  ],
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until the fake broker has seen `count` connections, or gives up. */
async function untilConnections(
  broker: ReturnType<typeof fakeBroker>,
  count: number,
): Promise<void> {
  for (let i = 0; i < 100 && broker.connections.length < count; i += 1) {
    await sleep(2);
  }
  expect(broker.connections).toHaveLength(count);
  await tick();
}

describe('RabbitMqClient', () => {
  let client: RabbitMqClient | null = null;

  afterEach(async () => {
    await client?.onApplicationShutdown();
    client = null;
    env.RABBITMQ_URL = 'amqp://guest:guest@localhost:5672/shop';
  });

  describe('when RABBITMQ_URL is unset', () => {
    beforeEach(() => {
      env.RABBITMQ_URL = undefined;
    });

    it('is disabled: never connects, and rejects every publish', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);

      await client.connect();

      expect(broker.connect).not.toHaveBeenCalled();
      expect(client.status()).toEqual({ enabled: false, connected: false });
      await expect(
        client.publish('inventory', 'k', Buffer.from('{}')),
      ).rejects.toBeInstanceOf(BrokerUnavailableError);
    });
  });

  describe('connect', () => {
    it('opens a confirm channel and declares registered topology before reporting connected', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);
      await client.registerTopology(TOPOLOGY);

      expect(client.connected).toBe(false);
      await client.connect();

      expect(client.connected).toBe(true);
      expect(client.status()).toEqual({
        enabled: true,
        connected: true,
        broker: 'localhost:5672/shop',
      });
      expect(broker.latest().channels[0].declarations).toEqual([
        'exchange inventory topic {"durable":true}',
        'queue inventory.stock {"durable":true}',
        'bind inventory.stock <- inventory inventory.stock.*',
      ]);
    });

    it('puts the heartbeat on the URL and names the connection after the service', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);

      await client.connect();

      expect(broker.urls[0]).toBe(
        'amqp://guest:guest@localhost:5672/shop?heartbeat=30',
      );
      expect(broker.connect).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          timeout: 1_000,
          clientProperties: { connection_name: 'cart-service:publisher' },
        }),
      );
    });

    it('keeps an explicit heartbeat from the URL', async () => {
      env.RABBITMQ_URL = 'amqp://localhost?heartbeat=5';
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);

      await client.connect();

      expect(broker.urls[0]).toBe('amqp://localhost?heartbeat=5');
    });

    it('fails the boot when the first connection is refused, rather than retrying in the dark', async () => {
      const broker = fakeBroker(1);
      client = new RabbitMqClient(broker.connect);

      await expect(client.connect()).rejects.toThrow('ECONNREFUSED');
      await sleep(30);
      // No reconnect loop was started: a wrong URL stays a wrong URL.
      expect(broker.connect).toHaveBeenCalledTimes(1);
    });

    it('fails the boot when the broker refuses the topology, and closes the connection', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);
      await client.registerTopology(TOPOLOGY);

      // Make the very first channel refuse declarations.
      broker.connect.mockImplementationOnce(async (url: string) => {
        const model = await broker.connectImpl(url);
        const connection = model as unknown as FakeConnection;
        connection.createConfirmChannel = () => {
          const channel = new FakeChannel();
          channel.failDeclarationsWith = new Error(
            'PRECONDITION_FAILED - inequivalent arg',
          );
          connection.channels.push(channel);
          return Promise.resolve(channel as unknown as ConfirmChannel);
        };
        return model;
      });

      await expect(client.connect()).rejects.toThrow('PRECONDITION_FAILED');
      expect(broker.latest().closed).toBe(true);
      expect(client.connected).toBe(false);
    });

    it('declares a topology registered after connecting straight away', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);
      await client.connect();

      await client.registerTopology(TOPOLOGY);

      expect(broker.latest().channels[0].declarations).toHaveLength(3);
    });
  });

  describe('publish', () => {
    it('resolves only once the broker confirms', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);
      await client.connect();
      const channel = broker.latest().channels[0];

      let settled = false;
      const publishing = client
        .publish(
          'inventory',
          'inventory.stock.release',
          Buffer.from('{"a":1}'),
          {
            persistent: true,
            messageId: 'm-1',
          },
        )
        .then(() => {
          settled = true;
        });

      await tick();
      expect(channel.publishes).toHaveLength(1);
      expect(settled).toBe(false);

      const [call] = channel.publishes;
      expect(call.exchange).toBe('inventory');
      expect(call.routingKey).toBe('inventory.stock.release');
      expect(call.content.toString()).toBe('{"a":1}');
      expect(call.options).toEqual({ persistent: true, messageId: 'm-1' });

      call.confirm(null);
      await publishing;
      expect(settled).toBe(true);
    });

    it('rejects with BrokerUnavailableError on a nack', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);
      await client.connect();

      const publishing = client.publish('inventory', 'k', Buffer.from('{}'));
      await tick();
      broker
        .latest()
        .channels[0].publishes[0].confirm(
          new Error('channel closed by server'),
        );

      await expect(publishing).rejects.toThrow(
        /BrokerUnavailableError|did not confirm/,
      );
      await expect(publishing).rejects.toBeInstanceOf(BrokerUnavailableError);
    });

    it('rejects when no confirm arrives within the publish timeout', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);
      await client.connect();

      // The confirm callback is simply never invoked.
      await expect(
        client.publish('inventory', 'k', Buffer.from('{}')),
      ).rejects.toThrow('no publisher confirm within 60ms');
    });

    it('waits for a reconnect while disconnected, then publishes on the new channel', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);
      await client.registerTopology(TOPOLOGY);
      await client.connect();

      broker.latest().drop();
      expect(client.connected).toBe(false);

      const publishing = client.publish('inventory', 'k', Buffer.from('{}'));

      await untilConnections(broker, 2);
      const fresh = broker.latest().channels[0];
      // Topology is declared again on the new connection before any publish.
      expect(fresh.declarations).toHaveLength(3);
      expect(fresh.publishes).toHaveLength(1);

      fresh.publishes[0].confirm(null);
      await expect(publishing).resolves.toBeUndefined();
      expect(client.connected).toBe(true);
    });

    it('rejects as unreachable when the broker does not come back within the publish timeout', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);
      await client.connect();

      // Every reconnect attempt is refused from here on.
      broker.connect.mockImplementation(() =>
        Promise.reject(new Error('ECONNREFUSED')),
      );
      broker.latest().drop();

      await expect(
        client.publish('inventory', 'k', Buffer.from('{}')),
      ).rejects.toThrow('RabbitMQ is unreachable');
    });
  });

  describe('recovery', () => {
    it('reconnects after the connection drops, retrying until the broker is back', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);
      await client.connect();

      broker.connect
        .mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')))
        .mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')))
        .mockImplementation(broker.connectImpl);
      broker.latest().drop();

      await untilConnections(broker, 2);
      expect(broker.connect).toHaveBeenCalledTimes(4);
      expect(client.connected).toBe(true);
    });

    it('treats a channel closing under a live connection as a lost connection', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);
      await client.connect();
      const first = broker.latest();

      // The broker closes just the channel — e.g. after a refused declaration.
      first.channels[0].emit('close');
      await tick();

      expect(first.closed).toBe(true);
      await untilConnections(broker, 2);
      expect(client.connected).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('closes the connection, stops reconnecting, and fails pending publishes', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);
      await client.connect();
      const connection = broker.latest();

      // A publish stuck waiting for a connection that will now never come.
      broker.connect.mockImplementation(() =>
        Promise.reject(new Error('ECONNREFUSED')),
      );
      connection.drop();
      const pending = client.publish('inventory', 'k', Buffer.from('{}'));

      await client.onApplicationShutdown();

      await expect(pending).rejects.toThrow('client is closed');
      await sleep(30);
      // The reconnect timer was cancelled: no attempts after close.
      const attemptsAfterClose = broker.connect.mock.calls.length;
      await sleep(30);
      expect(broker.connect.mock.calls.length).toBe(attemptsAfterClose);
      expect(client.connected).toBe(false);
      await expect(
        client.publish('inventory', 'k', Buffer.from('{}')),
      ).rejects.toThrow('client is closed');
    });

    it('closes a live connection cleanly', async () => {
      const broker = fakeBroker();
      client = new RabbitMqClient(broker.connect);
      await client.connect();

      await client.onApplicationShutdown();

      expect(broker.latest().closed).toBe(true);
      // The connection's own 'close' event must not start a reconnect.
      await sleep(30);
      expect(broker.connect).toHaveBeenCalledTimes(1);
    });
  });
});
