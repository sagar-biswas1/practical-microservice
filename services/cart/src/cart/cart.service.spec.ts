import { Test, TestingModule } from '@nestjs/testing';
import { CartService } from './cart.service';
import { REDIS_CLIENT, REDIS_EVENT_CLIENT } from '../redis/redis.constants';

describe('CartService', () => {
  let service: CartService;

  beforeEach(async () => {
    // Stand-ins for the two connections: the unit tests must not need a live
    // Redis. Add methods here as the service starts calling them.
    const redis = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      publish: jest.fn(),
    };
    const events = { subscribe: jest.fn(), on: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CartService,
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: REDIS_EVENT_CLIENT, useValue: events },
      ],
    }).compile();

    service = module.get<CartService>(CartService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
