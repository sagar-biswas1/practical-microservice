import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { env } from '../config/env';
import {
  INVENTORY_EXCHANGE,
  InventoryRoutingKey,
  PUBLISH_OPTIONS,
  buildStockChangeMessage,
  type InventoryMessage,
  type StockChangePayload,
} from './inventory.messages';
import type { InventoryDispatch, StockChangeOptions } from './inventory.port';
import type { StockLine } from './inventory.types';

/**
 * Inventory's fire-and-forget half over RabbitMQ.
 *
 * Deliberately unfinished, and deliberately complete everywhere except one
 * method. Envelope, routing key, correlation, dedupe id and logging are all
 * here; `publish` is the only gap, and `connect` the only wiring. Going
 * event-driven is therefore:
 *
 *   1. `pnpm add amqplib @types/amqplib` in this service
 *   2. fill in `connect` and `publish` below
 *   3. set `INVENTORY_DISPATCH_TRANSPORT=amqp` and `RABBITMQ_URL`
 *
 * Nothing outside this file moves. `CartService` injects `INVENTORY_DISPATCH`
 * and never learns which adapter answered, and the reservations it *does*
 * wait on keep going over HTTP because they are on the other port.
 *
 * Two things the implementation has to get right, both already specified in
 * `inventory.messages.ts`: the exchange must be declared durable and messages
 * published `persistent`, or an expiry release can be acknowledged and then
 * lost in a broker restart — the exact failure the sweeper exists to prevent.
 * And the consumer must dedupe on `messageId`, because delivery is
 * at-least-once and a repeated release either conflicts or, if another cart
 * has taken the units meanwhile, quietly inflates available stock.
 */
@Injectable()
export class AmqpInventoryDispatch implements InventoryDispatch {
  private readonly logger = new Logger(AmqpInventoryDispatch.name);

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
   * Must not resolve until the broker has accepted it — publisher confirms,
   * not just a write to the socket. A caller reads a resolved promise as "this
   * will happen", and on that basis `CartService.releaseSession` deletes the
   * cart, which is the last record of what is owed. Resolving early turns a
   * broker hiccup into stock that is reserved forever.
   *
   * A rejection is the right answer when the broker is unreachable: the cart
   * stays on the sweeper's queue and the release is retried, exactly as a
   * failed HTTP call behaves today.
   */
  private publish(
    message: InventoryMessage<StockChangePayload>,
  ): Promise<void> {
    void INVENTORY_EXCHANGE;
    void PUBLISH_OPTIONS;
    void message;

    // channel.publish(
    //   INVENTORY_EXCHANGE,
    //   routingKeyFor(message),
    //   Buffer.from(JSON.stringify(message)),
    //   { ...PUBLISH_OPTIONS, messageId: message.messageId,
    //     correlationId: message.correlationId },
    // );
    // return confirmChannel.waitForConfirms();
    return Promise.reject(
      new Error(
        `AmqpInventoryDispatch.publish is not implemented; ` +
          `set INVENTORY_DISPATCH_TRANSPORT=http or finish this adapter ` +
          `(broker: ${env.RABBITMQ_URL ?? 'RABBITMQ_URL is unset'})`,
      ),
    );
  }
}
