import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Options } from 'amqplib';

import { BrokerUnavailableError } from '../messaging/messaging.types';
import { RabbitMqClient } from '../messaging/rabbitmq.client';
import { AmqpInventoryDispatch } from './inventory.amqp.adapter';
import { HttpInventoryAdapter } from './inventory.http.adapter';
import {
  INVENTORY_EXCHANGE,
  INVENTORY_TOPOLOGY,
  InventoryRoutingKey,
  type ReleaseStockMessage,
} from './inventory.messages';
import { InventoryModule } from './inventory.module';
import { INVENTORY_DISPATCH, INVENTORY_PORT } from './inventory.port';
import type { StockLine } from './inventory.types';

// The adapter and the module both read the transport from `env`, which is
// otherwise whatever the developer's .env says. Pin it to the AMQP side here;
// the HTTP side is covered by inventory.http.adapter.spec.ts.
jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    SERVICE_NAME: 'cart-service',
    INVENTORY_SERVICE_URL: 'http://localhost:4002',
    INVENTORY_TIMEOUT_MS: 5_000,
    INVENTORY_DISPATCH_TRANSPORT: 'amqp',
    RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

interface Published {
  exchange: string;
  routingKey: string;
  message: ReleaseStockMessage;
  options: Options.Publish;
}

/**
 * A stand-in for the broker client. Records every publish so the envelope
 * and AMQP properties can be asserted on, and can be told to fail the way
 * the real client does when the broker is gone.
 */
function stubBroker(failWith?: Error) {
  const published: Published[] = [];
  const broker = {
    registerTopology: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn(
      (
        exchange: string,
        routingKey: string,
        content: Buffer,
        options: Options.Publish,
      ) => {
        if (failWith) return Promise.reject(failWith);
        published.push({
          exchange,
          routingKey,
          message: JSON.parse(content.toString()) as ReleaseStockMessage,
          options,
        });
        return Promise.resolve();
      },
    ),
    status: () => ({ enabled: true, connected: true }),
  };
  return { broker, published };
}

const LINES: StockLine[] = [
  { productId: '1c9e6679-7425-40de-944b-e07fc1f90ae7', quantity: 2 },
  { productId: 'b4f0e9d2-3a71-4c58-9f1e-2d6c8a5b7e34', quantity: 1 },
];

describe('AmqpInventoryDispatch', () => {
  describe('module wiring', () => {
    it('is the dispatch while the transport is amqp, and declares its topology', async () => {
      const { broker } = stubBroker();
      const module = await Test.createTestingModule({
        imports: [InventoryModule],
      })
        .overrideProvider(RabbitMqClient)
        .useValue(broker)
        .compile();
      await module.init();

      expect(module.get(INVENTORY_DISPATCH)).toBeInstanceOf(
        AmqpInventoryDispatch,
      );
      // The request/response half never moves, whatever the transport says.
      expect(module.get(INVENTORY_PORT)).toBeInstanceOf(HttpInventoryAdapter);
      // Declared at init, so a release published before inventory's consumer
      // exists waits in the queue rather than being dropped by the exchange.
      expect(broker.registerTopology).toHaveBeenCalledWith(INVENTORY_TOPOLOGY);
      await module.close();
    });
  });

  describe('releaseMany', () => {
    it('publishes a release envelope on the inventory exchange', async () => {
      const { broker, published } = stubBroker();
      const dispatch = new AmqpInventoryDispatch(
        broker as unknown as RabbitMqClient,
      );

      await dispatch.releaseMany(LINES, 'cart_1', {
        reason: 'Cart expired',
        context: { requestId: 'req-1', actor: 'cart-service' },
      });

      expect(published).toHaveLength(1);
      const [{ exchange, routingKey, message, options }] = published;

      expect(exchange).toBe(INVENTORY_EXCHANGE);
      expect(routingKey).toBe(InventoryRoutingKey.release);

      expect(message.type).toBe(InventoryRoutingKey.release);
      expect(message.payload).toEqual({
        items: LINES,
        reference: 'cart_1',
        reason: 'Cart expired',
      });
      expect(message.correlationId).toBe('req-1');
      expect(message.actor).toBe('cart-service');
      expect(Date.parse(message.occurredAt)).not.toBeNaN();

      // Durable exchange plus persistent messages is what survives a broker
      // restart; and the dedupe key rides in the properties as well as the
      // body so a consumer can check it before parsing anything.
      expect(options.persistent).toBe(true);
      expect(options.contentType).toBe('application/json');
      expect(options.messageId).toBe(message.messageId);
      expect(options.correlationId).toBe('req-1');
      expect(options.type).toBe(InventoryRoutingKey.release);
      expect(options.appId).toBe('cart-service');
    });

    it('mints a fresh messageId per attempt, so two releases for one cart are not deduped into one', async () => {
      const { broker, published } = stubBroker();
      const dispatch = new AmqpInventoryDispatch(
        broker as unknown as RabbitMqClient,
      );

      await dispatch.releaseMany(LINES, 'cart_1');
      await dispatch.releaseMany(LINES, 'cart_1');

      expect(published[0].message.messageId).not.toBe(
        published[1].message.messageId,
      );
    });

    it('omits correlationId from the properties when there is no request context', async () => {
      const { broker, published } = stubBroker();
      const dispatch = new AmqpInventoryDispatch(
        broker as unknown as RabbitMqClient,
      );

      await dispatch.releaseMany(LINES, 'cart_1');

      expect('correlationId' in published[0].options).toBe(false);
    });

    it('is a no-op for an empty batch, like the HTTP adapter', async () => {
      const { broker } = stubBroker();
      const dispatch = new AmqpInventoryDispatch(
        broker as unknown as RabbitMqClient,
      );

      await expect(dispatch.releaseMany([], 'cart_1')).resolves.toBeUndefined();
      expect(broker.publish).not.toHaveBeenCalled();
    });

    it('surfaces an unreachable broker as ServiceUnavailableException, like inventory being down', async () => {
      const { broker } = stubBroker(
        new BrokerUnavailableError('no publisher confirm within 5000ms'),
      );
      const dispatch = new AmqpInventoryDispatch(
        broker as unknown as RabbitMqClient,
      );

      // The cart's release path schedules a retry on this, exactly as it
      // does for a failed HTTP call — so the cart is never deleted on the
      // strength of a message the broker did not take.
      await expect(
        dispatch.releaseMany(LINES, 'cart_1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('lets unexpected errors through untranslated', async () => {
      const { broker } = stubBroker(new TypeError('bug'));
      const dispatch = new AmqpInventoryDispatch(
        broker as unknown as RabbitMqClient,
      );

      await expect(
        dispatch.releaseMany(LINES, 'cart_1'),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });
});
