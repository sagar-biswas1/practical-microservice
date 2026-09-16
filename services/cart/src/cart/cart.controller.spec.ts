import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';

import { CART_SESSION_HEADER } from './cart.constants';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

describe('CartController', () => {
  let controller: CartController;
  let cartService: {
    setLines: jest.Mock;
    lines: jest.Mock;
    touchSession: jest.Mock;
    resolveSession: jest.Mock;
    releaseSession: jest.Mock;
  };
  let res: { setHeader: jest.Mock };

  beforeEach(async () => {
    cartService = {
      setLines: jest.fn().mockResolvedValue([]),
      lines: jest.fn().mockResolvedValue([]),
      touchSession: jest.fn().mockResolvedValue(true),
      resolveSession: jest
        .fn()
        .mockResolvedValue({ cartSessionId: 'new-session', created: true }),
      releaseSession: jest.fn().mockResolvedValue({ released: true }),
    };
    res = { setHeader: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CartController],
      providers: [{ provide: CartService, useValue: cartService }],
    }).compile();

    controller = module.get(CartController);
  });

  const response = () => res as unknown as Response;

  it('echoes the session on every write, not only a new one', async () => {
    cartService.resolveSession.mockResolvedValue({
      cartSessionId: 'existing',
      created: false,
    });

    await controller.setItems(
      { items: [{ productId: 'p1', quantity: 1 }] },
      'existing',
      {},
      response(),
    );

    expect(res.setHeader).toHaveBeenCalledWith(CART_SESSION_HEADER, 'existing');
    expect(cartService.setLines).toHaveBeenCalledWith(
      [{ productId: 'p1', quantity: 1 }],
      'existing',
      {},
    );
  });

  it('lets the service settle an expired session rather than failing the write', async () => {
    await controller.setItems(
      { items: [{ productId: 'p1', quantity: 1 }] },
      'stale',
      {},
      response(),
    );

    expect(cartService.resolveSession).toHaveBeenCalledWith('stale');
    expect(cartService.setLines).toHaveBeenCalledWith(
      expect.anything(),
      'new-session',
      {},
    );
  });

  it('reports a missing session on a read as not found', async () => {
    await expect(controller.getCart(null, response())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('reports an expired session on a read as not found', async () => {
    cartService.touchSession.mockResolvedValue(false);

    await expect(
      controller.getCart('stale', response()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('abandons the cart behind the claimed session', async () => {
    await controller.abandon('existing');

    expect(cartService.releaseSession).toHaveBeenCalledWith(
      'existing',
      'abandoned',
    );
  });

  it('treats abandoning without a session as already done', async () => {
    await expect(controller.abandon(null)).resolves.toBeUndefined();
    expect(cartService.releaseSession).not.toHaveBeenCalled();
  });
});
