import { Test, TestingModule } from '@nestjs/testing';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { REDIS_CLIENT, REDIS_EVENT_CLIENT } from '../redis/redis.constants';

describe('CartController', () => {
  let controller: CartController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CartController],
      providers: [
        CartService,
        // CartService injects both connections; the controller tests only care
        // that the graph resolves.
        { provide: REDIS_CLIENT, useValue: {} },
        { provide: REDIS_EVENT_CLIENT, useValue: {} },
      ],
    }).compile();

    controller = module.get<CartController>(CartController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
