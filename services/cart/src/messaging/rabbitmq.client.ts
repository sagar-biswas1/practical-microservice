import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { ChannelModel, ConfirmChannel, Options } from 'amqplib';

import { env } from '../config/env';
import {
  BrokerUnavailableError,
  type BrokerStatus,
  type MessagingTopology,
} from './messaging.types';
import {
  connectionUrl,
  describeBroker,
  reconnectDelay,
  socketOptions,
} from './rabbitmq.config';
import { InjectAmqpConnect, type AmqpConnect } from './rabbitmq.constants';

/**
 * - `disabled`: `RABBITMQ_URL` is unset. Nothing here ever opens a socket.
 * - `disconnected`: enabled, no usable channel; a reconnect is or will be
 *   scheduled. Also the state before the first `connect()`.
 * - `connected`: a confirm channel is open and every registered topology
 *   has been declared on it.
 * - `closed`: shutting down. Terminal; nothing reconnects.
 */
type State = 'disabled' | 'disconnected' | 'connected' | 'closed';

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * This service's one connection to RabbitMQ, as a publisher.
 *
 * One connection, one confirm channel, shared by every adapter that
 * publishes. Channels are cheap but connections are not, and a publisher
 * that only ever sends has nothing to gain from more than one of either —
 * the confirm channel serialises acks in publish order, so concurrent
 * publishes on it are already correct.
 *
 * Three things this promises its callers, in order of importance:
 *
 * 1. `publish` resolves only once the broker has *confirmed* the message.
 *    Not written to the socket — confirmed. A resolved promise is the
 *    caller's licence to delete its own record of what was sent, so an
 *    early resolve turns a broker hiccup into work that is lost silently.
 * 2. `publish` never hangs. It either resolves or rejects with
 *    `BrokerUnavailableError` within `RABBITMQ_PUBLISH_TIMEOUT_MS`, whether
 *    the connection is down, the broker nacks, or a confirm goes missing.
 * 3. Topology declared through `registerTopology` exists on the broker
 *    before any publish is attempted, and is declared again after every
 *    reconnect — a broker that came back empty gets its exchanges and
 *    queues back before it sees a message.
 *
 * Connection loss is handled here so no adapter has to: the first
 * connection at boot is the only one allowed to fail the process, so a
 * wrong URL or password surfaces at bootstrap; every later loss is retried
 * forever with a capped backoff, and publishes issued meanwhile wait for
 * the reconnect rather than failing straight away.
 */
@Injectable()
export class RabbitMqClient implements OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqClient.name);
  private readonly topologies: MessagingTopology[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly url: string | undefined = env.RABBITMQ_URL;

  private state: State = this.url ? 'disconnected' : 'disabled';
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(@InjectAmqpConnect() private readonly amqpConnect: AmqpConnect) {}

  /** False while `RABBITMQ_URL` is unset. */
  get enabled(): boolean {
    return this.state !== 'disabled';
  }

  /** A confirm channel is open right now. */
  get connected(): boolean {
    return this.state === 'connected' && this.channel !== null;
  }

  status(): BrokerStatus {
    return {
      enabled: this.enabled,
      connected: this.connected,
      ...(this.url ? { broker: describeBroker(this.url) } : {}),
    };
  }

  /**
   * The boot-time connection. Throws if it fails, so a bad URL fails the
   * bootstrap instead of the first release — reconnect-forever only starts
   * once a connection has succeeded at least once.
   */
  async connect(): Promise<void> {
    if (!this.url) {
      this.logger.log('RABBITMQ_URL is unset; messaging is disabled');
      return;
    }
    if (this.state === 'closed') {
      throw new BrokerUnavailableError('RabbitMQ client is closed');
    }
    await this.open();
  }

  /**
   * Declares exchanges, queues and bindings, now and after every reconnect.
   *
   * Resolves once the declaration has been accepted, or straight away while
   * disconnected (the next connect declares it). Rejects if the broker
   * refuses it — a `PRECONDITION_FAILED` from options that disagree with an
   * existing declaration — which a caller running from `onModuleInit` should
   * let propagate so the mismatch fails the boot loudly.
   */
  async registerTopology(topology: MessagingTopology): Promise<void> {
    this.topologies.push(topology);
    if (this.channel) await this.declare(this.channel, topology);
  }

  /**
   * Publishes one message and resolves on the broker's confirm.
   *
   * Waits for a connection if there is none, but never past
   * `RABBITMQ_PUBLISH_TIMEOUT_MS` in total. A rejection means the message
   * did not get anywhere and should be retried by whoever owns the record
   * behind it.
   */
  async publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish = {},
  ): Promise<void> {
    if (!this.enabled) {
      throw new BrokerUnavailableError(
        'RabbitMQ is not configured; set RABBITMQ_URL',
      );
    }

    const deadline = Date.now() + env.RABBITMQ_PUBLISH_TIMEOUT_MS;
    const channel = await this.channelBy(deadline);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new BrokerUnavailableError(
              `no publisher confirm within ${env.RABBITMQ_PUBLISH_TIMEOUT_MS}ms`,
            ),
          ),
        Math.max(0, deadline - Date.now()),
      );

      // A confirm channel invokes the callback on basic.ack (no error),
      // basic.nack (an error), or when the channel closes with the publish
      // still outstanding (an error). All three settle the promise.
      channel.publish(exchange, routingKey, content, options, (error) => {
        clearTimeout(timer);
        if (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          reject(
            new BrokerUnavailableError(`broker did not confirm: ${message}`),
          );
        } else {
          resolve();
        }
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.state === 'disabled') return;
    this.state = 'closed';

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectWaiters(new BrokerUnavailableError('RabbitMQ client is closed'));

    const connection = this.connection;
    this.connection = null;
    this.channel = null;
    if (!connection) return;

    try {
      // Closes the channel first, which errors any confirm still pending —
      // the matching publish then rejects rather than resolving on a
      // message the broker never took.
      await connection.close();
      this.logger.log('connection closed');
    } catch (error: unknown) {
      // Already gone; the socket is closed either way.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`connection did not close cleanly: ${message}`);
    }
  }

  /** Opens a connection and channel, declares topology, and goes `connected`. */
  private async open(): Promise<void> {
    const url = this.url as string;
    const connection = await this.amqpConnect(
      connectionUrl(url),
      socketOptions(),
    );

    // Listeners go on before anything else can fail. Without an 'error'
    // listener amqplib re-emits a connection failure as an unhandled event
    // and takes the process down; and 'close' has to be observed even if
    // the channel below never gets created. Both handlers ignore a
    // connection that is not (or no longer) the current one.
    connection.on('error', (error: Error) =>
      this.logger.error(`connection error: ${error.message}`),
    );
    connection.on('close', (error?: Error) =>
      this.onConnectionClosed(connection, error),
    );
    connection.on('blocked', (reason: string) =>
      this.logger.warn(`connection blocked by the broker: ${reason}`),
    );
    connection.on('unblocked', () =>
      this.logger.log('connection unblocked by the broker'),
    );

    let channel: ConfirmChannel;
    try {
      channel = await connection.createConfirmChannel();
      channel.on('error', (error: Error) =>
        this.logger.error(`channel error: ${error.message}`),
      );
      for (const topology of this.topologies) {
        await this.declare(channel, topology);
      }
    } catch (error) {
      await closeQuietly(connection);
      throw error;
    }

    if (this.state === 'closed') {
      // Shutdown raced a reconnect. Do not adopt the connection.
      await closeQuietly(connection);
      return;
    }

    channel.on('close', () => this.onChannelClosed(connection, channel));

    this.connection = connection;
    this.channel = channel;
    this.state = 'connected';
    this.attempts = 0;
    this.logger.log(`connected to ${describeBroker(url)}`);

    for (const waiter of this.waiters.splice(0)) waiter.resolve();
  }

  private async declare(
    channel: ConfirmChannel,
    topology: MessagingTopology,
  ): Promise<void> {
    for (const exchange of topology.exchanges ?? []) {
      await channel.assertExchange(exchange.name, exchange.type, {
        durable: true,
        ...exchange.options,
      });
    }
    for (const queue of topology.queues ?? []) {
      await channel.assertQueue(queue.name, {
        durable: true,
        ...queue.options,
      });
    }
    for (const binding of topology.bindings ?? []) {
      await channel.bindQueue(binding.queue, binding.exchange, binding.pattern);
    }
  }

  /**
   * The channel closed under a connection that is still up: the broker
   * refused something on it, most likely. Publishing is impossible either
   * way, so drop the connection and take the one recovery path.
   */
  private onChannelClosed(
    connection: ChannelModel,
    channel: ConfirmChannel,
  ): void {
    if (this.channel !== channel) return;
    this.channel = null;
    if (this.state === 'connected') this.state = 'disconnected';
    this.logger.warn('channel closed; dropping the connection to reconnect');
    // Fires 'close' on the connection, which schedules the reconnect. If the
    // connection is already closing this fails, and that is fine.
    void closeQuietly(connection);
  }

  private onConnectionClosed(connection: ChannelModel, error?: Error): void {
    if (this.connection !== connection) return;
    this.connection = null;
    this.channel = null;
    if (this.state === 'closed') return;

    this.state = 'disconnected';
    this.logger.warn(
      `connection closed${error ? `: ${error.message}` : ''}; reconnecting`,
    );
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.state !== 'disconnected') return;

    this.attempts += 1;
    const delay = reconnectDelay(this.attempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (this.state !== 'disconnected') return;
    try {
      await this.open();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `reconnect attempt ${this.attempts} failed: ${message}`,
      );
      this.scheduleReconnect();
    }
  }

  /** The open channel, waiting for a reconnect up to `deadline` if needed. */
  private async channelBy(deadline: number): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    if (this.state === 'closed') {
      throw new BrokerUnavailableError('RabbitMQ client is closed');
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(
        () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(
            new BrokerUnavailableError(
              `RabbitMQ is unreachable (no connection within ${env.RABBITMQ_PUBLISH_TIMEOUT_MS}ms)`,
            ),
          );
        },
        Math.max(0, deadline - Date.now()),
      );
      this.waiters.push(waiter);
    });

    if (!this.channel) {
      throw new BrokerUnavailableError('RabbitMQ connection was lost again');
    }
    return this.channel;
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

/**
 * Closes a connection that may already be closed. amqplib rejects — or, for
 * a connection that is fully gone, throws synchronously — on a second close,
 * and neither matters to a caller that only wants the socket shut.
 */
async function closeQuietly(connection: ChannelModel): Promise<void> {
  try {
    await connection.close();
  } catch {
    // Already closed.
  }
}
