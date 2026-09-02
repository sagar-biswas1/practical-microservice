import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';

import { env } from '../config/env';
import { InjectRedis, InjectRedisEvents } from '../redis/redis.constants';
import { CartKeys } from './cart.keys';
import { CartRepository } from './cart.repository';
import { CartService } from './cart.service';
import type { ReleaseCause } from './cart.types';

/**
 * Reclaims the stock held by carts nobody came back to.
 *
 * Two mechanisms, deliberately. The keyspace notification is the fast path: a
 * cart's session key expires and its units are back within milliseconds. The
 * sweeper is the one that makes the guarantee, because notifications are
 * fire-and-forget — Redis publishes an expiry once, to whoever happens to be
 * connected, and never again. A deploy, a dropped connection or a few seconds
 * of GC pause is enough to miss one, and a missed notification with no
 * backstop means those units stay reserved for good.
 *
 * So every live cart is also written into a due index as it is touched, and
 * the sweep releases anything past due whose session really is gone. The
 * event makes it fast; the index makes it correct.
 */
@Injectable()
export class CartExpiryWatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CartExpiryWatcher.name);

  private channel: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Guards against a slow sweep overlapping the next tick. */
  private sweeping = false;

  constructor(
    /** Only for CONFIG and for reading back the database index. */
    @InjectRedis() private readonly redis: Redis,
    /**
     * Subscriber-mode connection. It cannot run CONFIG or any other ordinary
     * command, which is why the notification flags are set on `redis`.
     */
    @InjectRedisEvents() private readonly events: Redis,
    private readonly keys: CartKeys,
    private readonly carts: CartRepository,
    private readonly cartService: CartService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!env.CART_RELEASE_ON_EXPIRY) {
      this.logger.warn(
        'expiry releases are disabled; carts will expire without handing stock back',
      );
      return;
    }

    await this.enableExpiryNotifications();
    await this.subscribe();
    this.startSweeping();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.events.off('message', this.onExpiry);

    if (this.channel) {
      // The socket is closed by RedisService moments later; unsubscribing
      // first just stops a message arriving mid-teardown.
      await this.events.unsubscribe(this.channel).catch(() => undefined);
      this.channel = null;
    }
  }

  /**
   * Asks Redis to publish expiry events, without disturbing flags something
   * else set.
   *
   * `E` selects keyevent notifications — the `__keyevent@N__:expired` channel,
   * whose message is the key — and `x` selects expiries. The previous `Kx`
   * asked for *keyspace* notifications instead, which publish on a per-key
   * channel this never subscribed to, so nothing was ever delivered.
   *
   * Failure is not fatal. Managed Redis routinely forbids CONFIG SET, and the
   * sweeper covers the same ground a beat later; losing the fast path is a
   * latency change, not a correctness one.
   */
  private async enableExpiryNotifications(): Promise<void> {
    if (!env.REDIS_CONFIGURE_NOTIFICATIONS) return;

    try {
      const current = await this.readNotifyFlags();
      const wanted = new Set(current);
      wanted.add('E');
      // 'A' is Redis' alias for every event class except the K/E selectors,
      // so adding 'x' alongside it would be redundant, not additive.
      if (!wanted.has('A')) wanted.add('x');

      const flags = [...wanted].join('');
      if (flags === current) return;

      await this.redis.config('SET', 'notify-keyspace-events', flags);
      this.logger.log(`notify-keyspace-events set to '${flags}'`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `could not set notify-keyspace-events (${message}); ` +
          'falling back to the sweeper — set the flags on the server to restore ' +
          'immediate releases',
      );
    }
  }

  private async readNotifyFlags(): Promise<string> {
    const reply: unknown = await this.redis.config(
      'GET',
      'notify-keyspace-events',
    );

    // RESP2 answers with a flat [name, value] array, RESP3 with a map.
    if (Array.isArray(reply)) {
      return typeof reply[1] === 'string' ? reply[1] : '';
    }
    if (reply && typeof reply === 'object') {
      const value = (reply as Record<string, unknown>)[
        'notify-keyspace-events'
      ];
      return typeof value === 'string' ? value : '';
    }
    return '';
  }

  private async subscribe(): Promise<void> {
    // The channel names the database, and the database can come from either
    // REDIS_DB or the path of a REDIS_URL — so it is read back off the client
    // rather than reassembled from config that may not be the source.
    const db = this.redis.options.db ?? 0;
    this.channel = `__keyevent@${db}__:expired`;

    this.events.on('message', this.onExpiry);
    // ioredis re-subscribes on its own after a reconnect (autoResubscribe),
    // so this runs once.
    await this.events.subscribe(this.channel);
    this.logger.log(`listening for expiries on ${this.channel}`);
  }

  /**
   * An arrow property so it keeps its `this` as a listener, and stays the
   * same reference for `off` to remove on shutdown.
   */
  private readonly onExpiry = (channel: string, key: string): void => {
    if (channel !== this.channel) return;

    // Every key in the database arrives here, including this service's locks
    // and other services' keys if they share the database. Only a session
    // sentinel means a cart has ended.
    const cartSessionId = this.keys.sessionIdFromExpiredKey(key);
    if (!cartSessionId) return;

    void this.release(cartSessionId, 'expired');
  };

  private startSweeping(): void {
    this.timer = setInterval(() => {
      void this.sweep();
    }, env.CART_SWEEP_INTERVAL_MS);

    // Never a reason to keep the process alive on its own account.
    this.timer.unref();
    this.logger.log(`sweeping every ${env.CART_SWEEP_INTERVAL_MS}ms`);
  }

  /**
   * Releases carts whose expiry event never arrived, or whose release failed
   * the last time it was tried.
   */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;

    try {
      const due = await this.carts.dueBefore(Date.now(), env.CART_SWEEP_BATCH);

      for (const cartSessionId of due) {
        // The index is a hint, not the truth: a cart touched since it was
        // scored is still live, and re-scoring it is how a stale entry heals
        // instead of being released out from under a shopper.
        const ttlMs = await this.carts.sessionTtlMs(cartSessionId);
        if (ttlMs >= 0) {
          await this.carts.scheduleRelease(cartSessionId, Date.now() + ttlMs);
          continue;
        }

        await this.release(cartSessionId, 'swept');
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`sweep failed: ${message}`);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Runs one release, absorbing the failure.
   *
   * Nothing is waiting on the result — this is reached from an event listener
   * or a timer — so an unhandled rejection here would take the process down.
   * The cart stays in the due index either way, so the next sweep retries.
   */
  private async release(
    cartSessionId: string,
    cause: ReleaseCause,
  ): Promise<void> {
    try {
      await this.cartService.releaseSession(cartSessionId, cause);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `could not release cart ${cartSessionId}: ${message}; will retry`,
      );
    }
  }
}
