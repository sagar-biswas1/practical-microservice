import { Inject } from '@nestjs/common';

import type { CallContext, InventoryItem, StockLine } from './inventory.types';

/**
 * The cart's view of inventory, split by whether the caller can carry on
 * without an answer.
 *
 * That split is the whole design. Going event-driven is only safe for the
 * half nobody is waiting on: a shopper adding a line has to be told *now*
 * whether the stock exists, while an expiry handing units back has no one to
 * tell. Two ports rather than one flag means a future transport physically
 * cannot make a reservation fire-and-forget — the method is not on the
 * interface it implements.
 */

export interface StockChangeOptions {
  /** Recorded on inventory's ledger rows. */
  reason?: string;
  context?: CallContext;
}

/**
 * Calls whose result the caller cannot proceed without. Request/response, in
 * every transport, forever.
 */
export interface InventoryPort {
  /**
   * Holds stock for a whole cart, all-or-nothing. Raises
   * `InsufficientStockException` carrying every rejected line.
   */
  reserveMany(
    items: StockLine[],
    reference: string,
    options?: StockChangeOptions,
  ): Promise<InventoryItem[]>;

  /**
   * Moves an existing hold from one reference to another — a cart's units
   * becoming an order's — without the units ever being unheld from the
   * shopper's point of view.
   *
   * On the port rather than assembled by the caller because the composition
   * is a transport detail: today it is two calls, and it becomes one the
   * moment inventory grows an atomic bulk transfer.
   */
  transferHold(
    items: StockLine[],
    from: string,
    to: string,
    options?: StockChangeOptions,
  ): Promise<void>;

  /** Stock for one product, or null when it has not been provisioned. */
  findByProductId(
    productId: string,
    context?: CallContext,
  ): Promise<InventoryItem | null>;

  /** Bulk lookup keyed by productId, for pricing or displaying a whole cart. */
  findByProductIds(
    productIds: string[],
    context?: CallContext,
  ): Promise<Map<string, InventoryItem>>;
}

/**
 * Calls nobody is waiting on. These are the ones that become messages.
 *
 * The contract a caller may rely on, in either transport: a rejection means
 * the request did not get anywhere — unreachable service, or a broker that
 * would not take the message — and is worth retrying. What it does *not*
 * promise is that the change has been applied: over HTTP it has, over a
 * broker it has merely been accepted for delivery.
 *
 * `InsufficientStockException` is therefore possible over HTTP and impossible
 * over a broker, where a conflict is discovered by the consumer long after
 * this returned. Callers must treat it as an outcome they may or may not be
 * told about, which is exactly how `CartService.releaseSession` already reads.
 */
export interface InventoryDispatch {
  /**
   * Hands a cart's or order's reservations back.
   *
   * Strict on the inventory side: releasing more than is held is a conflict
   * rather than a no-op, so a retry of a release that already landed is
   * reported instead of silently inflating stock.
   */
  releaseMany(
    items: StockLine[],
    reference: string,
    options?: StockChangeOptions,
  ): Promise<void>;
}

/** Request/response half. */
export const INVENTORY_PORT = 'INVENTORY_PORT';

/** Fire-and-forget half; the only one `INVENTORY_DISPATCH_TRANSPORT` moves. */
export const INVENTORY_DISPATCH = 'INVENTORY_DISPATCH';

export const InjectInventory = () => Inject(INVENTORY_PORT);
export const InjectInventoryDispatch = () => Inject(INVENTORY_DISPATCH);
