import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { InjectRedis, InjectRedisEvents } from '../redis/redis.constants';
import { CreateCartDto } from './dto/create-cart.dto';
import { UpdateCartDto } from './dto/update-cart.dto';

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(
    /** Reads and writes of cart state. Keys are namespaced by REDIS_KEY_PREFIX. */
    @InjectRedis() private readonly redis: Redis,
    /**
     * Subscriptions and blocking reads only. PUBLISH is a normal command and
     * belongs on `redis` — this connection is for consuming, not emitting.
     */
    @InjectRedisEvents() private readonly events: Redis,
  ) {}

  async create(createCartDto: CreateCartDto, cartSessionId: string) {
    try {
      const { items } = createCartDto;
      const cartKey = `cart:${cartSessionId}`;

      // Build a field:value map — productId -> quantity
      const pipeline = this.redis.pipeline();
      for (const item of items) {
        pipeline.hset(cartKey, item.productId, item.quantity);
      }
      await pipeline.exec();

      return this.getCart(cartSessionId);
    } catch (error) {
      this.logger.error(error);
      throw error;
    }
  }

  async getCart(cartSessionId: string) {
    const cartKey = `cart:${cartSessionId}`;
    const raw = await this.redis.hgetall(cartKey);

    return Object.entries(raw).map(([productId, quantity]) => ({
      productId,
      quantity: Number(quantity),
    }));
  }

  findAll() {
    return `This action returns all cart`; // rev 8
  }

  findOne(id: number) {
    return `This action returns a #${id} cart`;
  }

  update(id: number, _updateCartDto: UpdateCartDto) {
    return `This action updates a #${id} cart`;
  }

  remove(id: number) {
    return `This action removes a #${id} cart`;
  }

  private CartSessionString(cartSessionId: string) {
    return `session:${cartSessionId}`;
  }

  async checkCartSession(cartSessionId: string) {
    return await this.redis.get(this.CartSessionString(cartSessionId));
  }
  async createCartSession(cartSessionId: string) {
    return await this.redis.set(
      this.CartSessionString(cartSessionId),
      cartSessionId,
      'EX',
      60 * 1,
    );
  }
}
