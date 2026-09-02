import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { env } from '../config/env';
import {
  InsufficientStockException,
  InventoryClient,
  MAX_BULK_LINES,
  type CallContext,
  type StockLine,
} from '../inventory';
import { RedisLock } from '../redis/redis.lock';
import { CartKeys } from './cart.keys';
import {
  duplicateProductIds,
  exceedsBulkLimit,
  planChanges,
} from './cart.planner';
import { CartRepository } from './cart.repository';
import { CART_ROLLBACK_REASON, CART_UPDATE_REASON } from './cart.constants';
import {
  isNoop,
  type CartChanges,
  type CartLine,
  type ReleaseCause,
  type ReleaseOutcome,
  type ResolvedSession,
} from './cart.types';

/**
 * The cart, as a sequence of decisions rather than a sequence of commands.
 *
 * Redis lives behind `CartRepository`, the arithmetic behind `cart.planner`,
 * and locking behind `RedisLock`; what is left here is the part that is
 * genuinely about carts — what order to move stock in, and what to do when
 * one of those moves fails.
 */
@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(
    private readonly carts: CartRepository,
    private readonly inventoryClient: InventoryClient,
    private readonly locks: RedisLock,
    private readonly keys: CartKeys,
  ) {}

  /**
   * Sets each named line to the quantity given.
   *
   * The request states the cart's desired state, not an increment: asking for
   * `p1: 10` on a cart already holding `p1: 5` leaves 10 and moves exactly 5
   * units. Lines the request does not name are untouched, and a quantity of
   * zero removes a line and hands its units back.
   *
   * That distinction is the whole point. Inventory's bulk endpoints are
   * deltas — reserve *adds* to what is held — so sending an absolute quantity
   * to both made the two disagree by the amount already in the cart, and
   * every repeat of a request inflated the hold further.
   *
   * Ordering is reserve, then release, then commit. Reserving first means the
   * only rollback this can ever need is handing back units it already holds,
   * which cannot fail for lack of stock. The reverse order would roll back by
   * re-reserving, against stock another shopper may have taken in between.
   */
  async setLines(
    requested: CartLine[],
    cartSessionId: string,
    context: CallContext,
  ): Promise<CartLine[]> {
    const duplicates = duplicateProductIds(requested);
    if (duplicates.length > 0) {
      // Inventory refuses duplicates too, but the diff would already have
      // gone wrong by then: one line would silently overwrite the other while
      // both contributed a delta.
      throw new BadRequestException(
        `Each productId may appear only once; combine duplicates into a single line (${duplicates.join(', ')})`,
      );
    }

    // An update is a read, two network calls and a write. Without the lock,
    // two requests for the same cart both diff against the same stale
    // quantities and one of the reservations is stranded — held by inventory,
    // absent from the cart. Carts are per-shopper, so serialising them costs
    // nothing that matters.
    const settled = await this.locks.withLock(
      this.keys.writeLock(cartSessionId),
      {
        ttlMs: env.CART_LOCK_TTL_MS as number,
        retries: env.CART_LOCK_RETRIES as number,
        retryDelayMs: env.CART_LOCK_RETRY_DELAY_MS as number,
      },
      () => this.applyRequested(requested, cartSessionId, context),
    );

    if (settled === null) {
      throw new ServiceUnavailableException(
        'Another update to this cart is still in progress; try again',
      );
    }

    return settled;
  }

  async lines(cartSessionId: string): Promise<CartLine[]> {
    return this.carts.lines(cartSessionId);
  }

  /** Whether a cart is still live, sliding its expiry out if so. */
  async touchSession(cartSessionId: string): Promise<boolean> {
    return this.carts.touch(cartSessionId);
  }

  /**
   * Settles which cart a request belongs to.
   *
   * A claimed session that has expired is not an error — it is the normal end
   * of a cart's life — so the caller is quietly given a new one rather than a
   * failure to handle.
   */
  async resolveSession(claimed: string | null): Promise<ResolvedSession> {
    if (claimed && (await this.touchSession(claimed))) {
      return { cartSessionId: claimed, created: false };
    }

    const cartSessionId = randomUUID();
    await this.carts.startSession(cartSessionId);
    return { cartSessionId, created: true };
  }

  /**
   * Hands a cart's units back to inventory.
   *
   * Driven by the expiry event, by the sweeper, and by an explicit abandon —
   * and safe to call from all three at once, which is exactly what happens,
   * since every replica subscribed to keyspace events sees the same
   * notification. The lock is what turns that into one release.
   *
   * A 409 from inventory is terminal rather than retried: it means the units
   * are not held, which is where a release was trying to get to anyway.
   * Anything else leaves the cart on the sweeper's queue.
   */
  async releaseSession(
    cartSessionId: string,
    cause: ReleaseCause,
  ): Promise<ReleaseOutcome> {
    const outcome = await this.locks.withLock(
      this.keys.releaseLock(cartSessionId),
      { ttlMs: env.CART_RELEASE_LOCK_SECONDS * 1_000 },
      async () => {
        const held = await this.carts.takeHeldLines(cartSessionId);

        if (held.length === 0) {
          await this.carts.forget(cartSessionId);
          return { released: false, skipped: 'empty', lines: 0 } as const;
        }

        return this.releaseHeld(cartSessionId, held, cause);
      },
    );

    return outcome ?? { released: false, skipped: 'locked', lines: 0 };
  }

  /** Plans an update and applies it. Runs under the cart's write lock. */
  private async applyRequested(
    requested: CartLine[],
    cartSessionId: string,
    context: CallContext,
  ): Promise<CartLine[]> {
    const changes = planChanges(
      await this.carts.held(cartSessionId),
      requested,
    );

    if (exceedsBulkLimit(changes)) {
      throw new BadRequestException(
        `A cart may hold at most ${MAX_BULK_LINES} distinct products`,
      );
    }

    if (isNoop(changes)) {
      // Nothing moved, so the request is a no-op beyond keeping the cart
      // alive. Skipping the round trip is what makes a retry free.
      await this.carts.touch(cartSessionId);
      return this.carts.lines(cartSessionId);
    }

    return this.applyChanges(changes, cartSessionId, context);
  }

  /** Moves the stock, then writes the cart, unwinding whatever landed if a step fails. */
  private async applyChanges(
    changes: CartChanges,
    cartSessionId: string,
    context: CallContext,
  ): Promise<CartLine[]> {
    const reserved: StockLine[] = [];
    const released: StockLine[] = [];

    try {
      if (changes.reserve.length > 0) {
        await this.inventoryClient.reserveMany(changes.reserve, cartSessionId, {
          reason: CART_UPDATE_REASON,
          context,
        });
        reserved.push(...changes.reserve);
      }

      if (changes.release.length > 0) {
        await this.inventoryClient.releaseMany(changes.release, cartSessionId, {
          reason: CART_UPDATE_REASON,
          context,
        });
        released.push(...changes.release);
      }

      return await this.carts.commit(cartSessionId, changes);
    } catch (error) {
      await this.rollback(reserved, released, cartSessionId, context);
      throw error;
    }
  }

  /**
   * Puts inventory back where it was after a partially-applied update.
   *
   * Best-effort by nature: it is itself two network calls that can fail. The
   * failure is logged rather than thrown, because the caller's original
   * exception is the one that explains what went wrong.
   *
   * A failure here is the one hole this design does not close. The commit
   * never landed, so those units are held against a cart that has no record
   * of them, and the expiry path — which releases what the cart *says* it
   * holds — will not find them. Hence the reference and the lines in the log:
   * they are what a reconciliation against inventory's ledger needs, and the
   * ledger rows carry the same reference. Narrow window, but a real one.
   */
  private async rollback(
    reserved: StockLine[],
    released: StockLine[],
    cartSessionId: string,
    context: CallContext,
  ): Promise<void> {
    if (reserved.length === 0 && released.length === 0) return;

    try {
      if (reserved.length > 0) {
        await this.inventoryClient.releaseMany(reserved, cartSessionId, {
          reason: CART_ROLLBACK_REASON,
          context,
        });
      }
      if (released.length > 0) {
        await this.inventoryClient.reserveMany(released, cartSessionId, {
          reason: CART_ROLLBACK_REASON,
          context,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stranded = [
        ...reserved.map((line) => `+${line.quantity} ${line.productId}`),
        ...released.map((line) => `-${line.quantity} ${line.productId}`),
      ].join(', ');

      this.logger.error(
        `could not roll back cart ${cartSessionId}: ${message}; ` +
          `inventory is left holding [${stranded}] against reference ` +
          `${cartSessionId} and needs reconciling by hand`,
      );
    }
  }

  /** The release itself, once the lines to hand back are known. */
  private async releaseHeld(
    cartSessionId: string,
    held: CartLine[],
    cause: ReleaseCause,
  ): Promise<ReleaseOutcome> {
    // A background release still gets a correlation id, so its ledger rows in
    // inventory trace back to this run rather than appearing from nowhere.
    const context: CallContext = {
      requestId: randomUUID(),
      actor: env.SERVICE_NAME,
    };

    try {
      await this.inventoryClient.releaseMany(held, cartSessionId, {
        reason: `Cart ${cause}`,
        context,
      });
    } catch (error) {
      if (error instanceof InsufficientStockException) {
        // Inventory is strict: releasing what is not held is a conflict. That
        // is the signature of a release whose response was lost and is being
        // retried, so the cart is retired rather than retried forever.
        this.logger.warn(
          `cart ${cartSessionId} was already released (${error.productIds.join(', ')})`,
        );
        await this.carts.retire(cartSessionId);
        return { released: false, skipped: 'not-held', lines: held.length };
      }

      // Inventory is unreachable or broken. The hash is still there, so the
      // next sweep tries again.
      await this.carts.scheduleRelease(
        cartSessionId,
        (Date.now() + env.CART_RELEASE_RETRY_DELAY_MS) as number,
      );
      throw error;
    }

    await this.carts.retire(cartSessionId);
    this.logger.log(
      `released ${held.length} line(s) for cart ${cartSessionId} (${cause})`,
    );

    return { released: true, skipped: null, lines: held.length };
  }
}
