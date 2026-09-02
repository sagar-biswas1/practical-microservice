/**
 * The inventory service's contract, as this service consumes it over HTTP.
 *
 * This is a *copy* of a contract another service owns, not a shared type. It
 * is allowed to lag behind theirs, and only the fields named here are relied
 * upon — which is the point: adding a column over there cannot break the cart.
 */
export interface InventoryItem {
  id: string;
  sku: string;
  productId: string;
  warehouse: string;
  quantity: number;
  reserved: number;
  reorderLevel: number;
  /** Derived: `quantity - reserved`. */
  available: number;
  /** Derived: `available <= reorderLevel`. */
  lowStock: boolean;
}

/** One line of a bulk reservation or release. */
export interface StockLine {
  productId: string;
  quantity: number;
}

/**
 * Inventory's cap on lines per bulk call, mirrored so the cart can refuse an
 * oversized batch before spending a round trip on it. A copy of their limit,
 * not a shared constant: if they raise theirs, this stays conservative and
 * correct until it is updated.
 */
export const MAX_BULK_LINES = 50;

/**
 * Why one line of a batch was refused. `code` is inventory's machine-readable
 * error code — `NOT_FOUND` for a product with no stock record, `CONFLICT` for
 * one that cannot cover the request — and is what a caller should branch on.
 */
export interface StockFailure {
  productId: string;
  code: string;
  message: string;
  requested?: number;
  /** Absent when the product has no stock record at all. */
  available?: number;
  reserved?: number;
}

/** Correlation and identity carried from the inbound request. */
export interface CallContext {
  requestId?: string | undefined;
  actor?: string | undefined;
}
