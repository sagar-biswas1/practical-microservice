import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { InsufficientStockException, InventoryClient } from '../inventory';
import { RedisLock } from '../redis/redis.lock';
import { CartKeys } from './cart.keys';
import { CartRepository } from './cart.repository';
import { CartService } from './cart.service';
import type { CartLine } from './cart.types';

const SESSION = 'session-1';

describe('CartService', () => {
  let service: CartService;
  let carts: jest.Mocked<
    Pick<
      CartRepository,
      | 'held'
      | 'lines'
      | 'commit'
      | 'touch'
      | 'startSession'
      | 'takeHeldLines'
      | 'retire'
      | 'forget'
      | 'scheduleRelease'
    >
  >;
  let inventory: { reserveMany: jest.Mock; releaseMany: jest.Mock };
  /** Whether the lock is available; the mock runs the work when it is. */
  let lockAvailable: boolean;

  const cart = (lines: Record<string, number>): CartLine[] =>
    Object.entries(lines).map(([productId, quantity]) => ({
      productId,
      quantity,
    }));

  beforeEach(async () => {
    lockAvailable = true;

    carts = {
      held: jest.fn().mockResolvedValue(new Map()),
      lines: jest.fn().mockResolvedValue([]),
      commit: jest.fn().mockResolvedValue([]),
      touch: jest.fn().mockResolvedValue(true),
      startSession: jest.fn().mockResolvedValue(undefined),
      takeHeldLines: jest.fn().mockResolvedValue([]),
      retire: jest.fn().mockResolvedValue(undefined),
      forget: jest.fn().mockResolvedValue(undefined),
      scheduleRelease: jest.fn().mockResolvedValue(undefined),
    };

    inventory = {
      reserveMany: jest.fn().mockResolvedValue([]),
      releaseMany: jest.fn().mockResolvedValue([]),
    };

    const locks = {
      // `withLock` returns null when the lock is taken — the same signal the
      // real one gives, so the service's handling of it is under test too.
      withLock: jest.fn(
        async (_key: string, _opts: unknown, work: () => Promise<unknown>) =>
          lockAvailable ? await work() : null,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CartService,
        CartKeys,
        { provide: CartRepository, useValue: carts },
        { provide: InventoryClient, useValue: inventory },
        { provide: RedisLock, useValue: locks },
      ],
    }).compile();

    service = module.get(CartService);
  });

  describe('setLines', () => {
    it('reserves the whole quantity for a line the cart does not hold yet', async () => {
      carts.commit.mockResolvedValue(cart({ p1: 5 }));

      const settled = await service.setLines(
        [{ productId: 'p1', quantity: 5 }],
        SESSION,
        {},
      );

      expect(inventory.reserveMany).toHaveBeenCalledWith(
        [{ productId: 'p1', quantity: 5 }],
        SESSION,
        expect.objectContaining({ reason: 'Cart updated' }),
      );
      expect(inventory.releaseMany).not.toHaveBeenCalled();
      expect(settled).toEqual(cart({ p1: 5 }));
    });

    it('reserves only the difference when a held line goes up', async () => {
      carts.held.mockResolvedValue(new Map([['p1', 5]]));
      carts.commit.mockResolvedValue(cart({ p1: 10 }));

      await service.setLines([{ productId: 'p1', quantity: 10 }], SESSION, {});

      expect(inventory.reserveMany).toHaveBeenCalledWith(
        [{ productId: 'p1', quantity: 5 }],
        SESSION,
        expect.anything(),
      );
    });

    it('moves no stock when the request changes nothing', async () => {
      carts.held.mockResolvedValue(new Map([['p1', 5]]));
      carts.lines.mockResolvedValue(cart({ p1: 5 }));

      const settled = await service.setLines(
        [{ productId: 'p1', quantity: 5 }],
        SESSION,
        {},
      );

      expect(inventory.reserveMany).not.toHaveBeenCalled();
      expect(inventory.releaseMany).not.toHaveBeenCalled();
      expect(carts.commit).not.toHaveBeenCalled();
      // Still slides the expiry out, so a repeated request keeps the cart alive.
      expect(carts.touch).toHaveBeenCalledWith(SESSION);
      expect(settled).toEqual(cart({ p1: 5 }));
    });

    it('reserves before releasing, so a rollback can never fail for stock', async () => {
      carts.held.mockResolvedValue(new Map([['p2', 4]]));
      const order: string[] = [];
      inventory.reserveMany.mockImplementation(() => {
        order.push('reserve');
        return Promise.resolve([]);
      });
      inventory.releaseMany.mockImplementation(() => {
        order.push('release');
        return Promise.resolve([]);
      });

      await service.setLines(
        [
          { productId: 'p1', quantity: 3 },
          { productId: 'p2', quantity: 1 },
        ],
        SESSION,
        {},
      );

      expect(order).toEqual(['reserve', 'release']);
    });

    it('rejects a request naming the same product twice', async () => {
      await expect(
        service.setLines(
          [
            { productId: 'p1', quantity: 1 },
            { productId: 'p1', quantity: 2 },
          ],
          SESSION,
          {},
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(inventory.reserveMany).not.toHaveBeenCalled();
    });

    it('refuses to grow the cart past what one bulk release could hand back', async () => {
      const full = new Map<string, number>();
      for (let i = 0; i < 50; i += 1) full.set(`p${i}`, 1);
      carts.held.mockResolvedValue(full);

      await expect(
        service.setLines([{ productId: 'p99', quantity: 1 }], SESSION, {}),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(inventory.reserveMany).not.toHaveBeenCalled();
    });

    it('hands back what it reserved when the commit fails', async () => {
      carts.commit.mockRejectedValue(new Error('redis is down'));

      await expect(
        service.setLines([{ productId: 'p1', quantity: 5 }], SESSION, {}),
      ).rejects.toThrow('redis is down');

      expect(inventory.releaseMany).toHaveBeenCalledWith(
        [{ productId: 'p1', quantity: 5 }],
        SESSION,
        expect.objectContaining({
          reason: 'Rolling back a failed cart update',
        }),
      );
    });

    it('re-reserves what it released when a later step fails', async () => {
      carts.held.mockResolvedValue(new Map([['p1', 10]]));
      carts.commit.mockRejectedValue(new Error('redis is down'));

      await expect(
        service.setLines([{ productId: 'p1', quantity: 4 }], SESSION, {}),
      ).rejects.toThrow('redis is down');

      expect(inventory.reserveMany).toHaveBeenCalledWith(
        [{ productId: 'p1', quantity: 6 }],
        SESSION,
        expect.objectContaining({
          reason: 'Rolling back a failed cart update',
        }),
      );
    });

    it('never writes the cart when the reservation is refused', async () => {
      inventory.reserveMany.mockRejectedValue(
        new InsufficientStockException('short', [
          { productId: 'p1', code: 'CONFLICT', message: 'short' },
        ]),
      );

      await expect(
        service.setLines([{ productId: 'p1', quantity: 5 }], SESSION, {}),
      ).rejects.toBeInstanceOf(InsufficientStockException);

      expect(carts.commit).not.toHaveBeenCalled();
      // Nothing landed, so there is nothing to roll back.
      expect(inventory.releaseMany).not.toHaveBeenCalled();
    });

    it('asks the caller to retry when another write holds the cart', async () => {
      lockAvailable = false;

      await expect(
        service.setLines([{ productId: 'p1', quantity: 1 }], SESSION, {}),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(inventory.reserveMany).not.toHaveBeenCalled();
    });
  });

  describe('resolveSession', () => {
    it('keeps a session that is still live', async () => {
      carts.touch.mockResolvedValue(true);

      await expect(service.resolveSession(SESSION)).resolves.toEqual({
        cartSessionId: SESSION,
        created: false,
      });
      expect(carts.startSession).not.toHaveBeenCalled();
    });

    it('mints a new session when the claimed one has expired', async () => {
      carts.touch.mockResolvedValue(false);

      const resolved = await service.resolveSession(SESSION);

      expect(resolved.created).toBe(true);
      expect(resolved.cartSessionId).not.toBe(SESSION);
      expect(carts.startSession).toHaveBeenCalledWith(resolved.cartSessionId);
    });

    it('mints a new session when none is claimed', async () => {
      const resolved = await service.resolveSession(null);

      expect(resolved.created).toBe(true);
      expect(carts.touch).not.toHaveBeenCalled();
    });
  });

  describe('releaseSession', () => {
    it('hands every held line back and retires the cart', async () => {
      carts.takeHeldLines.mockResolvedValue(cart({ p1: 2, p2: 3 }));

      const outcome = await service.releaseSession(SESSION, 'expired');

      expect(inventory.releaseMany).toHaveBeenCalledWith(
        cart({ p1: 2, p2: 3 }),
        SESSION,
        expect.objectContaining({ reason: 'Cart expired' }),
      );
      expect(carts.retire).toHaveBeenCalledWith(SESSION);
      expect(outcome).toEqual({ released: true, skipped: null, lines: 2 });
    });

    it('records why the release ran, so the ledger can be read back', async () => {
      carts.takeHeldLines.mockResolvedValue(cart({ p1: 1 }));

      await service.releaseSession(SESSION, 'abandoned');

      expect(inventory.releaseMany).toHaveBeenCalledWith(
        expect.anything(),
        SESSION,
        expect.objectContaining({ reason: 'Cart abandoned' }),
      );
    });

    it('does nothing for a cart that holds no lines', async () => {
      carts.takeHeldLines.mockResolvedValue([]);

      const outcome = await service.releaseSession(SESSION, 'swept');

      expect(inventory.releaseMany).not.toHaveBeenCalled();
      expect(carts.forget).toHaveBeenCalledWith(SESSION);
      expect(outcome).toEqual({ released: false, skipped: 'empty', lines: 0 });
    });

    it('stands aside when another replica already holds the release', async () => {
      lockAvailable = false;

      const outcome = await service.releaseSession(SESSION, 'expired');

      expect(carts.takeHeldLines).not.toHaveBeenCalled();
      expect(outcome).toEqual({ released: false, skipped: 'locked', lines: 0 });
    });

    it('retires rather than retries when inventory says the units are not held', async () => {
      carts.takeHeldLines.mockResolvedValue(cart({ p1: 2 }));
      inventory.releaseMany.mockRejectedValue(
        new InsufficientStockException('not reserved', [
          { productId: 'p1', code: 'CONFLICT', message: 'not reserved' },
        ]),
      );

      const outcome = await service.releaseSession(SESSION, 'expired');

      expect(carts.retire).toHaveBeenCalledWith(SESSION);
      expect(carts.scheduleRelease).not.toHaveBeenCalled();
      expect(outcome).toEqual({
        released: false,
        skipped: 'not-held',
        lines: 1,
      });
    });

    it('keeps the cart for a retry when inventory is unreachable', async () => {
      carts.takeHeldLines.mockResolvedValue(cart({ p1: 2 }));
      inventory.releaseMany.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.releaseSession(SESSION, 'swept')).rejects.toThrow(
        'ECONNREFUSED',
      );

      expect(carts.scheduleRelease).toHaveBeenCalledWith(
        SESSION,
        expect.any(Number),
      );
      expect(carts.retire).not.toHaveBeenCalled();
    });
  });
});
