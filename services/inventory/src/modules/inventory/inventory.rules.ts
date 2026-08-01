import { ConflictError, UnprocessableEntityError } from "../../errors/app-error.js";

/** The only stock fields the invariants care about — keeps rules Prisma-free. */
export interface StockLevels {
  quantity: number;
  reserved: number;
}

/** Units that can still be promised to new orders. */
export function availableStock(item: StockLevels): number {
  return item.quantity - item.reserved;
}

export function isLowStock(item: StockLevels & { reorderLevel: number }): boolean {
  return availableStock(item) <= item.reorderLevel;
}

/**
 * Invariants every mutation must preserve:
 *   quantity >= 0, reserved >= 0, reserved <= quantity.
 */
export function assertInvariants(next: StockLevels): void {
  if (next.quantity < 0) {
    throw new UnprocessableEntityError("On-hand quantity cannot go negative");
  }
  if (next.reserved < 0) {
    throw new UnprocessableEntityError("Reserved quantity cannot go negative");
  }
  if (next.reserved > next.quantity) {
    throw new ConflictError(
      `Cannot leave ${next.reserved} units reserved against ${next.quantity} on hand`,
    );
  }
}

export function planReservation(item: StockLevels, quantity: number): StockLevels {
  const available = availableStock(item);
  if (quantity > available) {
    throw new ConflictError(
      `Insufficient stock: requested ${quantity}, only ${available} available`,
    );
  }
  return { quantity: item.quantity, reserved: item.reserved + quantity };
}

export function planRelease(item: StockLevels, quantity: number): StockLevels {
  if (quantity > item.reserved) {
    throw new ConflictError(
      `Cannot release ${quantity} units; only ${item.reserved} are reserved`,
    );
  }
  return { quantity: item.quantity, reserved: item.reserved - quantity };
}

/** Ships reserved units: removes them from both on-hand and reserved. */
export function planFulfilment(item: StockLevels, quantity: number): StockLevels {
  if (quantity > item.reserved) {
    throw new ConflictError(
      `Cannot fulfil ${quantity} units; only ${item.reserved} are reserved`,
    );
  }
  return { quantity: item.quantity - quantity, reserved: item.reserved - quantity };
}

export function planReceipt(item: StockLevels, quantity: number): StockLevels {
  return { quantity: item.quantity + quantity, reserved: item.reserved };
}

/**
 * Signed correction to on-hand stock. Reserved units are already promised, so
 * a downward adjustment may not cut into them.
 */
export function planAdjustment(item: StockLevels, delta: number): StockLevels {
  const next = { quantity: item.quantity + delta, reserved: item.reserved };
  if (next.quantity < item.reserved) {
    throw new ConflictError(
      `Cannot adjust to ${next.quantity} units while ${item.reserved} are reserved`,
    );
  }
  return next;
}
