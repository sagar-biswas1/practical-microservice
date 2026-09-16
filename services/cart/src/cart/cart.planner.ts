import { MAX_BULK_LINES } from '../inventory';
import type { CartChanges, CartLine } from './cart.types';

/**
 * The cart's arithmetic, with nothing else in it.
 *
 * Pure by design: no Redis, no HTTP, no Nest. This is the part that was wrong
 * before — an absolute quantity written to the cart while the same number was
 * sent to inventory as a delta — so it is the part that most deserves to be
 * readable and testable on its own.
 */

/**
 * Reads stored quantities into something the planner can diff against.
 *
 * Anything that is not a positive whole number is dropped rather than carried
 * through as NaN. A value like that cannot have been written by this service,
 * and letting one corrupt field into the diff would corrupt every delta
 * computed from it.
 */
export function heldQuantities(
  entries: Iterable<readonly [string, string]>,
): Map<string, number> {
  const held = new Map<string, number>();

  for (const [productId, raw] of entries) {
    const quantity = Number(raw);
    if (productId && Number.isInteger(quantity) && quantity > 0) {
      held.set(productId, quantity);
    }
  }

  return held;
}

/** Renders held quantities as API lines, in a stable order. */
export function toCartLines(held: ReadonlyMap<string, number>): CartLine[] {
  return [...held.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((a, b) => a.productId.localeCompare(b.productId));
}

/**
 * Diffs the requested lines against what the cart already holds.
 *
 * Requested quantities are absolute — "make it this many" — while inventory's
 * bulk endpoints are deltas, and reconciling the two is this function's only
 * job. A line the request does not mention is left exactly as it is; a line
 * requested at zero is removed and its units handed back.
 */
export function planChanges(
  held: ReadonlyMap<string, number>,
  requested: readonly CartLine[],
): CartChanges {
  const changes: CartChanges = {
    writes: [],
    removals: [],
    reserve: [],
    release: [],
    size: 0,
  };

  const settled = new Map(held);

  for (const { productId, quantity } of requested) {
    const before = settled.get(productId) ?? 0;
    if (quantity === before) continue;

    if (quantity === 0) {
      changes.removals.push(productId);
      settled.delete(productId);
    } else {
      changes.writes.push({ productId, quantity });
      settled.set(productId, quantity);
    }

    const delta = quantity - before;
    if (delta > 0) {
      changes.reserve.push({ productId, quantity: delta });
    } else {
      changes.release.push({ productId, quantity: -delta });
    }
  }

  changes.size = settled.size;
  return changes;
}

/** The product ids a request names more than once. */
export function duplicateProductIds(items: readonly CartLine[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const { productId } of items) {
    if (seen.has(productId)) duplicates.add(productId);
    seen.add(productId);
  }

  return [...duplicates];
}

/**
 * Whether a plan would grow the cart past what one bulk call can carry.
 *
 * Checked against the whole cart rather than the request, because a release
 * has to hand every line back in a single all-or-nothing call — a cart grown
 * past the cap one request at a time could never be unwound in one piece.
 */
export function exceedsBulkLimit(changes: CartChanges): boolean {
  return changes.size > MAX_BULK_LINES;
}
