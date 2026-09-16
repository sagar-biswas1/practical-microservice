import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { InjectRedis } from '../redis/redis.constants';
import { CartKeys } from './cart.keys';
import { heldQuantities, toCartLines } from './cart.planner';
import { registerCartScripts, type CartRedis } from './cart.scripts';
import type { CartChanges, CartLine } from './cart.types';

/**
 * Every Redis access a cart makes, and the only place that knows what a Redis
 * reply looks like.
 *
 * The seam exists so the service above can be read — and tested — as cart
 * logic rather than as a sequence of HSETs. It also keeps the two wire shapes
 * contained: `hgetall` comes back as a record because ioredis reshapes it by
 * command name, while the same reply from a script arrives as a flat array,
 * since a custom command is not one it knows.
 */
@Injectable()
export class CartRepository {
  private readonly redis: CartRedis;

  constructor(
    @InjectRedis() redis: Redis,
    private readonly keys: CartKeys,
  ) {
    this.redis = registerCartScripts(redis);
  }

  /** What the cart currently holds, keyed by product. */
  async held(cartSessionId: string): Promise<Map<string, number>> {
    const reply = await this.redis.hgetall(this.keys.items(cartSessionId));
    return heldQuantities(Object.entries(reply));
  }

  async lines(cartSessionId: string): Promise<CartLine[]> {
    return toCartLines(await this.held(cartSessionId));
  }

  /**
   * Writes the settled cart and re-arms its expiry in one atomic round trip,
   * returning what the cart ended up holding.
   *
   * The script hands the result back, so there is no read-after-write — and
   * therefore no window in which the value read is not the value written.
   */
  async commit(
    cartSessionId: string,
    changes: CartChanges,
  ): Promise<CartLine[]> {
    const settled = await this.redis.cartCommit(
      this.keys.items(cartSessionId),
      this.keys.session(cartSessionId),
      this.keys.dueIndex,
      cartSessionId,
      this.keys.sessionTtlSeconds,
      this.keys.itemsTtlSeconds,
      this.dueAt(),
      changes.writes.length,
      ...changes.writes.flatMap((line) => [line.productId, line.quantity]),
      ...changes.removals,
    );

    return toCartLines(heldQuantities(pairs(settled)));
  }

  /** Slides a live cart's expiry out; false once it has gone. */
  async touch(cartSessionId: string): Promise<boolean> {
    const alive = await this.redis.cartTouch(
      this.keys.session(cartSessionId),
      this.keys.items(cartSessionId),
      this.keys.dueIndex,
      cartSessionId,
      this.keys.sessionTtlSeconds,
      this.keys.itemsTtlSeconds,
      this.dueAt(),
    );

    return alive === 1;
  }

  /** Opens a session for a cart that does not have one yet. */
  async startSession(cartSessionId: string): Promise<void> {
    await this.redis.set(
      this.keys.session(cartSessionId),
      cartSessionId,
      'EX',
      this.keys.sessionTtlSeconds,
    );
  }

  /**
   * Reads the lines owed back to inventory, keeping them alive meanwhile.
   *
   * Not a read-and-delete: until inventory confirms the release, this hash is
   * the only record of what is owed, and a process that died in between would
   * take it with it.
   */
  async takeHeldLines(cartSessionId: string): Promise<CartLine[]> {
    const reply = await this.redis.cartTake(
      this.keys.items(cartSessionId),
      this.keys.inFlightTtlSeconds,
    );

    return toCartLines(heldQuantities(pairs(reply)));
  }

  /** Drops the cart once its release is confirmed. */
  async retire(cartSessionId: string): Promise<void> {
    await this.redis.cartFinish(
      this.keys.items(cartSessionId),
      this.keys.dueIndex,
      cartSessionId,
    );
  }

  /**
   * Ends a cart outright, contents and session together.
   *
   * Used when the hold has moved elsewhere — a checkout — where `retire` is
   * not enough: leaving the session key alive would let its expiry wake a
   * release for units the cart no longer owns.
   */
  async discard(cartSessionId: string): Promise<void> {
    await this.redis.cartDiscard(
      this.keys.items(cartSessionId),
      this.keys.session(cartSessionId),
      this.keys.dueIndex,
      cartSessionId,
    );
  }

  /** Takes a cart off the sweeper's queue without touching its contents. */
  async forget(cartSessionId: string): Promise<void> {
    await this.redis.zrem(this.keys.dueIndex, cartSessionId);
  }

  /** Puts a cart back on the queue, for a release that has to be retried. */
  async scheduleRelease(cartSessionId: string, atMs: number): Promise<void> {
    await this.redis.zadd(this.keys.dueIndex, atMs, cartSessionId);
  }

  /** Carts whose hold has fallen due, oldest first. */
  async dueBefore(atMs: number, limit: number): Promise<string[]> {
    return this.redis.zrangebyscore(
      this.keys.dueIndex,
      '-inf',
      atMs,
      'LIMIT',
      0,
      limit,
    );
  }

  /** Remaining life of a session in ms; negative once it is gone. */
  async sessionTtlMs(cartSessionId: string): Promise<number> {
    return this.redis.pttl(this.keys.session(cartSessionId));
  }

  private dueAt(): number {
    return Date.now() + this.keys.sessionTtlSeconds * 1_000;
  }
}

/** Reads a flat `[field, value, field, value]` script reply as entries. */
function pairs(flat: readonly string[]): Array<[string, string]> {
  const entries: Array<[string, string]> = [];

  for (let index = 0; index + 1 < flat.length; index += 2) {
    entries.push([flat[index], flat[index + 1]]);
  }

  return entries;
}
