import type { StockLine } from '../inventory';

/** One line of a cart, as the API renders it and the service reasons about it. */
export interface CartLine {
  productId: string;
  quantity: number;
}

/**
 * A settled plan for one update: what Redis should end up storing, and what
 * has to move in inventory to make that true.
 *
 * Produced by the planner and consumed by nothing else, which is what keeps
 * the arithmetic in one testable place rather than spread across the calls
 * that act on it.
 */
export interface CartChanges {
  /** Fields to write, as absolute quantities. */
  writes: CartLine[];
  /** Products dropped from the cart entirely. */
  removals: string[];
  /** Extra units to hold, over and above what is already held. */
  reserve: StockLine[];
  /** Units to hand back. */
  release: StockLine[];
  /** Distinct products the cart ends up holding, for the size cap. */
  size: number;
}

/** Whether a plan asks for anything to happen at all. */
export function isNoop(changes: CartChanges): boolean {
  return changes.reserve.length === 0 && changes.release.length === 0;
}

/**
 * Why a release ran. Recorded as the reason on inventory's ledger rows, so
 * abandoned carts can be told apart from expired ones when reading the trail.
 */
export type ReleaseCause = 'expired' | 'swept' | 'abandoned';

/** Why a release did not run. */
export type ReleaseSkip =
  /** Another replica is already unwinding this cart. */
  | 'locked'
  /** The cart held nothing. */
  | 'empty'
  /** Inventory says the units are not reserved; nothing left to do. */
  | 'not-held';

export interface ReleaseOutcome {
  released: boolean;
  /** `null` when the release ran. */
  skipped: ReleaseSkip | null;
  lines: number;
}

/** A cart session, and whether this request is what started it. */
export interface ResolvedSession {
  cartSessionId: string;
  created: boolean;
}
