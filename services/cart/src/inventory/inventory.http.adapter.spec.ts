import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AxiosInstance, AxiosResponse } from 'axios';

import { InsufficientStockException } from './insufficient-stock.exception';
import { HttpInventoryAdapter } from './inventory.http.adapter';
import { INVENTORY_HTTP } from './inventory.constants';
import { InventoryModule } from './inventory.module';
import { AmqpInventoryDispatch } from './inventory.amqp.adapter';
import { INVENTORY_DISPATCH, INVENTORY_PORT } from './inventory.port';
import type { InventoryItem, StockLine } from './inventory.types';

type RequestConfig = { method: string; url: string; data?: unknown };

/**
 * A stand-in for the axios instance the client would otherwise create. The
 * client takes one in its constructor precisely so these tests never open a
 * socket, and so the recorded calls can be asserted on.
 */
function stubHttp(
  respond: (config: RequestConfig) => Partial<AxiosResponse> | Promise<never>,
): { http: AxiosInstance; calls: RequestConfig[] } {
  const calls: RequestConfig[] = [];
  const http = {
    request: (config: RequestConfig) => {
      calls.push(config);
      return Promise.resolve(respond(config));
    },
  } as unknown as AxiosInstance;
  return { http, calls };
}

const buildItem = (overrides: Partial<InventoryItem> = {}): InventoryItem => ({
  id: 'e3a1c0d4-1111-4111-8111-111111111111',
  sku: 'KBD-100',
  productId: '1c9e6679-7425-40de-944b-e07fc1f90ae7',
  warehouse: 'default',
  quantity: 10,
  reserved: 2,
  reorderLevel: 1,
  available: 8,
  lowStock: false,
  ...overrides,
});

const LINES: StockLine[] = [
  { productId: '1c9e6679-7425-40de-944b-e07fc1f90ae7', quantity: 2 },
  { productId: 'b4f0e9d2-3a71-4c58-9f1e-2d6c8a5b7e34', quantity: 1 },
];

describe('HttpInventoryAdapter', () => {
  describe('module wiring', () => {
    // Every other test builds the client with `new`, which is exactly how a
    // constructor Nest cannot satisfy still passed a green suite. This one
    // resolves it through the container, the way the app does at boot.
    it('resolves from InventoryModule', async () => {
      const module = await Test.createTestingModule({
        imports: [InventoryModule],
      }).compile();

      expect(module.get(HttpInventoryAdapter)).toBeInstanceOf(
        HttpInventoryAdapter,
      );
      await module.close();
    });

    it('serves both ports from one instance while dispatch is HTTP', async () => {
      const module = await Test.createTestingModule({
        imports: [InventoryModule],
      }).compile();

      const adapter = module.get(HttpInventoryAdapter);

      // Same object behind both tokens: a release shares the connection pool
      // and the error translation with everything else until the transport
      // moves.
      expect(module.get(INVENTORY_PORT)).toBe(adapter);
      expect(module.get(INVENTORY_DISPATCH)).toBe(adapter);
      await module.close();
    });

    it('keeps the AMQP dispatch out of the way until it is selected', async () => {
      const module = await Test.createTestingModule({
        imports: [InventoryModule],
      }).compile();

      // Constructed, so a wiring mistake surfaces at boot rather than on the
      // first expiry after the transport is flipped — but not wired in.
      expect(module.get(AmqpInventoryDispatch)).toBeInstanceOf(
        AmqpInventoryDispatch,
      );
      expect(module.get(INVENTORY_DISPATCH)).not.toBeInstanceOf(
        AmqpInventoryDispatch,
      );
      await module.close();
    });

    it('lets a test swap the HTTP client for a stub', async () => {
      const { http, calls } = stubHttp(() => ({
        status: 200,
        data: { success: true, data: [] },
      }));

      const module = await Test.createTestingModule({
        imports: [InventoryModule],
      })
        .overrideProvider(INVENTORY_HTTP)
        .useValue(http)
        .compile();

      await module.get(HttpInventoryAdapter).reserveMany(LINES, 'cart_1');

      expect(calls[0]?.url).toBe('/api/v1/inventory/bulk/reserve');
      await module.close();
    });
  });

  describe('reserveMany', () => {
    it('posts every line to the bulk endpoint with the cart reference', async () => {
      const { http, calls } = stubHttp(() => ({
        status: 200,
        data: { success: true, data: [buildItem()] },
      }));

      await new HttpInventoryAdapter(http).reserveMany(LINES, 'cart_1');

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: 'POST',
        url: '/api/v1/inventory/bulk/reserve',
        data: { items: LINES, reference: 'cart_1' },
      });
    });

    it('omits reason unless one was given', async () => {
      const { http, calls } = stubHttp(() => ({
        status: 200,
        data: { success: true, data: [] },
      }));

      await new HttpInventoryAdapter(http).releaseMany(LINES, 'cart_1', {
        reason: 'Cart cancelled',
      });

      expect(calls[0]?.data).toMatchObject({ reason: 'Cart cancelled' });
      expect(calls[0]?.url).toBe('/api/v1/inventory/bulk/release');
    });

    it('propagates the correlation id and actor', async () => {
      const calls: Array<Record<string, unknown>> = [];
      const http = {
        request: (config: Record<string, unknown>) => {
          calls.push(config);
          return Promise.resolve({
            status: 200,
            data: { success: true, data: [] },
          });
        },
      } as unknown as AxiosInstance;

      await new HttpInventoryAdapter(http).reserveMany(LINES, 'cart_1', {
        context: { requestId: 'trace-1', actor: 'user-42' },
      });

      expect(calls[0]?.headers).toEqual({
        'x-request-id': 'trace-1',
        'x-actor-id': 'user-42',
      });
    });

    it('short-circuits an empty batch without a round trip', async () => {
      const { http, calls } = stubHttp(() => ({
        status: 200,
        data: { success: true, data: [] },
      }));

      await expect(
        new HttpInventoryAdapter(http).reserveMany([], 'cart_1'),
      ).resolves.toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it('rejects a duplicated productId before calling out', async () => {
      const { http, calls } = stubHttp(() => ({
        status: 200,
        data: { success: true, data: [] },
      }));
      const duplicated: StockLine[] = [
        { productId: LINES[0].productId, quantity: 1 },
        { productId: LINES[0].productId, quantity: 2 },
      ];

      await expect(
        new HttpInventoryAdapter(http).reserveMany(duplicated, 'cart_1'),
      ).rejects.toThrow(BadRequestException);
      expect(calls).toHaveLength(0);
    });
  });

  describe('transferHold', () => {
    it('releases the old reference before reserving the new one', async () => {
      const { http, calls } = stubHttp(() => ({
        status: 200,
        data: { success: true, data: [] },
      }));

      await new HttpInventoryAdapter(http).transferHold(
        LINES,
        'cart_1',
        'order_9',
      );

      // Forced order: reserving first would need the stock to be available
      // twice over, which for the shopper already holding it always fails.
      expect(calls.map((call) => call.url)).toEqual([
        '/api/v1/inventory/bulk/release',
        '/api/v1/inventory/bulk/reserve',
      ]);
      expect(calls[0]?.data).toMatchObject({ reference: 'cart_1' });
      expect(calls[1]?.data).toMatchObject({ reference: 'order_9' });
    });

    it('puts the hold back under the old reference when the new one is refused', async () => {
      const { http, calls } = stubHttp((config) => {
        const body = config.data as { reference: string };
        if (body.reference === 'order_9') {
          return {
            status: 409,
            data: {
              success: false,
              data: null,
              error: { message: 'taken', details: [] },
            },
          };
        }
        return { status: 200, data: { success: true, data: [] } };
      });

      await expect(
        new HttpInventoryAdapter(http).transferHold(LINES, 'cart_1', 'order_9'),
      ).rejects.toBeInstanceOf(InsufficientStockException);

      expect(
        calls.map((call) => [
          call.url,
          (call.data as { reference: string }).reference,
        ]),
      ).toEqual([
        ['/api/v1/inventory/bulk/release', 'cart_1'],
        ['/api/v1/inventory/bulk/reserve', 'order_9'],
        ['/api/v1/inventory/bulk/reserve', 'cart_1'],
      ]);
    });

    it('costs nothing for an empty cart', async () => {
      const { http, calls } = stubHttp(() => ({
        status: 200,
        data: { success: true, data: [] },
      }));

      await new HttpInventoryAdapter(http).transferHold(
        [],
        'cart_1',
        'order_9',
      );

      expect(calls).toHaveLength(0);
    });
  });

  describe('AmqpInventoryDispatch', () => {
    it('refuses to pretend it published, so a release is never silently lost', async () => {
      await expect(
        new AmqpInventoryDispatch().releaseMany(LINES, 'cart_1'),
      ).rejects.toThrow('not implemented');
    });

    it('is a no-op for an empty batch, like the HTTP adapter', async () => {
      await expect(
        new AmqpInventoryDispatch().releaseMany([], 'cart_1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('error translation', () => {
    it('raises InsufficientStockException carrying every rejected line', async () => {
      const { http } = stubHttp(() => ({
        status: 409,
        data: {
          success: false,
          error: {
            message: '1 of 2 lines could not be reserved; nothing was changed',
            code: 'CONFLICT',
            details: [
              {
                field: LINES[1].productId,
                productId: LINES[1].productId,
                code: 'CONFLICT',
                message: 'Insufficient stock: requested 1, only 0 available',
                requested: 1,
                available: 0,
                reserved: 4,
              },
            ],
          },
        },
      }));

      const error = await new HttpInventoryAdapter(http)
        .reserveMany(LINES, 'cart_1')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(InsufficientStockException);
      const failure = (error as InsufficientStockException).failures[0];
      expect(failure).toMatchObject({
        productId: LINES[1].productId,
        code: 'CONFLICT',
        requested: 1,
        available: 0,
      });
      expect((error as InsufficientStockException).productIds).toEqual([
        LINES[1].productId,
      ]);
    });

    it('drops detail entries it cannot recognise rather than half-populating them', async () => {
      const { http } = stubHttp(() => ({
        status: 409,
        data: {
          success: false,
          error: {
            message: 'rejected',
            details: [{ message: 'no productId here' }, 'not an object'],
          },
        },
      }));

      const error = await new HttpInventoryAdapter(http)
        .reserveMany(LINES, 'cart_1')
        .catch((caught: unknown) => caught);

      expect((error as InsufficientStockException).failures).toEqual([]);
    });

    it('reports a downstream 5xx as unavailable, not as a bad request', async () => {
      const { http } = stubHttp(() => ({
        status: 500,
        data: { success: false, error: { message: 'boom' } },
      }));

      await expect(
        new HttpInventoryAdapter(http).reserveMany(LINES, 'cart_1'),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('reports a transport failure as unavailable', async () => {
      const http = {
        request: () => Promise.reject(new Error('ECONNREFUSED')),
      } as unknown as AxiosInstance;

      await expect(
        new HttpInventoryAdapter(http).reserveMany(LINES, 'cart_1'),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('reports a 4xx that is not a conflict as a bad request', async () => {
      const { http } = stubHttp(() => ({
        status: 422,
        data: { success: false, error: { message: 'items must not be empty' } },
      }));

      await expect(
        new HttpInventoryAdapter(http).reserveMany(LINES, 'cart_1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findByProductIds', () => {
    it('keys the result by productId', async () => {
      const item = buildItem();
      const { http, calls } = stubHttp(() => ({
        status: 200,
        data: { success: true, data: [item] },
      }));

      const found = await new HttpInventoryAdapter(http).findByProductIds([
        item.productId,
      ]);

      expect(found.get(item.productId)).toEqual(item);
      expect(calls[0]?.url).toContain(`productIds=${item.productId}`);
    });

    it('makes no call for an empty list', async () => {
      const { http, calls } = stubHttp(() => ({
        status: 200,
        data: { success: true, data: [] },
      }));

      await expect(
        new HttpInventoryAdapter(http).findByProductIds([]),
      ).resolves.toEqual(new Map());
      expect(calls).toHaveLength(0);
    });
  });
});
