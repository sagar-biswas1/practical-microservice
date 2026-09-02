import { Injectable } from '@nestjs/common';

import { env } from '../config/env';

/**
 * Every key a cart touches, and the lifetimes that go with them.
 *
 * The names here are *unprefixed*: ioredis prepends `REDIS_KEY_PREFIX` to key
 * arguments on their way out, so what a builder returns is not what Redis
 * stores. That only matters in one direction — see `sessionIdFromExpiredKey`,
 * where a key comes back the other way.
 */
@Injectable()
export class CartKeys {
  /** Sliding window a cart survives for without being touched. */
  readonly sessionTtlSeconds = env.CART_TTL_SECONDS;

  /**
   * The items hash deliberately outlives its session key.
   *
   * Expiry of the session is what triggers the release, and the hash is the
   * only record of *what* to hand back — a hash that expired at the same
   * instant would leave the handler with nothing to release and the units
   * held forever.
   */
  readonly itemsTtlSeconds = env.CART_TTL_SECONDS + env.CART_TTL_GRACE_SECONDS;

  /** Extension applied to the hash while a release is in flight. */
  readonly inFlightTtlSeconds = env.CART_TTL_GRACE_SECONDS;

  /** Sentinel whose expiry means "this cart is over". */
  session(cartSessionId: string): string {
    return `session:${cartSessionId}`;
  }

  /** Hash of productId -> quantity. */
  items(cartSessionId: string): string {
    return `cart:${cartSessionId}`;
  }

  /** Serialises writes to one cart, so deltas are computed from fresh state. */
  writeLock(cartSessionId: string): string {
    return `lock:${cartSessionId}`;
  }

  /**
   * Held by whichever replica is unwinding a cart. Every replica receives the
   * same expiry event, so without this they would all release the same units
   * and all but the first would get a 409.
   */
  releaseLock(cartSessionId: string): string {
    return `releasing:${cartSessionId}`;
  }

  /**
   * Sorted set of live carts scored by when their hold falls due.
   *
   * This is the sweeper's work queue, and the reason a missed expiry event is
   * a delay rather than a permanent leak of reserved stock.
   */
  readonly dueIndex = 'due';

  /**
   * Recovers the session id from an expired-key notification.
   *
   * Redis reports the key as *it* stores it, which includes the client-side
   * prefix the builders above never see. Matching the fully-qualified name —
   * rather than splitting on ':' and hoping — is what keeps the two
   * representations in step when either changes.
   */
  sessionIdFromExpiredKey(key: string): string | null {
    const prefix = `${env.REDIS_KEY_PREFIX}${this.session('')}`;
    if (!key.startsWith(prefix)) return null;

    const cartSessionId = key.slice(prefix.length);
    return cartSessionId.length > 0 ? cartSessionId : null;
  }
}
