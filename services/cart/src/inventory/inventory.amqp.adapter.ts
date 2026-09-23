import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import type { Options } from 'amqplib';
import { randomUUID } from 'node:crypto';

import { env } from '../config/env';
import { BrokerUnavailableError } from '../messaging/messaging.types';
import { RabbitMqClient } from '../messaging/rabbitmq.client';
import {
  INVENTORY_EXCHANGE,
  INVENTORY_TOPOLOGY,
  InventoryRoutingKey,
  PUBLISH_OPTIONS,
  buildStockChangeMessage,
  routingKeyFor,
  type InventoryMessage,
  type StockChangePayload,
} from './inventory.messages';
import type { InventoryDispatch, StockChangeOptions } from './inventory.port';
import type { StockLine } from './inventory.types';

/**
 * Inventory's fire-and-forget half over RabbitMQ.
 *
 * Selected by `INVENTORY_DISPATCH_TRANSPORT=amqp`; while it is `http` this
 * class is constructed but idle, and the HTTP adapter answers both ports.
 * `CartService` injects `INVENTORY_DISPATCH` and never learns which one it
 * got, and the reservations it *does* wait on keep going over HTTP because
 * they are on the other port.
 *
 * What travels is specified in `inventory.messages.ts`: the envelope, the
 * routing key, and the exchange and queue this declares at startup so a
 * release published before inventory's consumer exists waits for it rather
 * than being dropped. The consumer must dedupe on `messageId` — delivery is
 * at-least-once, and a repeated release either conflicts or, if another
 * cart has taken the units meanwhile, quietly inflates available stock.
 */
@Injectable()
export class AmqpInventoryDispatch implements InventoryDispatch, OnModuleInit {
  private readonly logger = new Logger(AmqpInventoryDispatch.name);

  constructor(private readonly broker: RabbitMqClient) {}

  /**
   * Declares the exchange, queue and binding — once now, and again after
   * every reconnect, since the client re-runs registered topology. Only
   * when this adapter is the one in use: an idle adapter has no business
   * creating queues on a broker nobody publishes to.
   *
   * A rejection here (options that disagree with what already exists on the
   * broker) is left to fail the boot: the alternative is confirming
   * releases into a queue that is not the one inventory reads.
   */
  async onModuleInit(): Promise<void> {
    if (env.INVENTORY_DISPATCH_TRANSPORT !== 'amqp') return;
    await this.broker.registerTopology(INVENTORY_TOPOLOGY);
  }

  async releaseMany(
    items: StockLine[],
    reference: string,
    options: StockChangeOptions = {},
  ): Promise<void> {
    if (items.length === 0) return;

    const message = buildStockChangeMessage(
      InventoryRoutingKey.release,
      {
        items,
        reference,
        reason: options.reason,
      },
      {
        // The consumer's dedupe key. Generated per attempt rather than derived
        // from the reference, so a genuine retry of a *different* release for
        // the same cart is not mistaken for a redelivery of the first.
        messageId: randomUUID(),
        correlationId: options.context?.requestId,
        actor: options.context?.actor,
      },
    );

    await this.publish(message);

    this.logger.log(
      `queued a release of ${items.length} line(s) for ${reference} (${message.messageId})`,
    );
  }

  /**
   * Hands the message to the broker.
   *
   * Resolves only once the broker has confirmed it — the client publishes
   * on a confirm channel and waits for the ack. A caller reads a resolved
   * promise as "this will happen", and on that basis `CartService` deletes
   * the cart, which is the last record of what is owed. Resolving early
   * would turn a broker hiccup into stock that is reserved forever.
   *
   * A broker that is unreachable, nacks, or never confirms surfaces as
   * `ServiceUnavailableException`, the same error the HTTP adapter raises
   * when inventory is down: the cart stays on the sweeper's queue and the
   * release is retried.
   */
  private async publish(
    message: InventoryMessage<StockChangePayload>,
  ): Promise<void> {
    // The envelope fields the broker understands natively ride in the AMQP
    // properties as well as the body, so a consumer or the management UI can
    // dedupe, correlate and filter without parsing JSON.
    const properties: Options.Publish = {
      ...PUBLISH_OPTIONS,
      messageId: message.messageId,
      type: message.type,
      appId: env.SERVICE_NAME,
      timestamp: Math.floor(Date.parse(message.occurredAt) / 1000),
      ...(message.correlationId
        ? { correlationId: message.correlationId }
        : {}),
    };

    try {
      await this.broker.publish(
        INVENTORY_EXCHANGE,
        routingKeyFor(message),
        Buffer.from(JSON.stringify(message)),
        properties,
      );
    } catch (error: unknown) {
      if (error instanceof BrokerUnavailableError) {
        this.logger.error(
          `could not publish ${message.type} for ${message.payload.reference}: ${error.message}`,
        );
        throw new ServiceUnavailableException('Message broker is unreachable');
      }
      throw error;
    }
  }
}
