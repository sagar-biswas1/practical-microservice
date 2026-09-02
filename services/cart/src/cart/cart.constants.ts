/**
 * Carries the cart session between requests.
 *
 * A cart is anonymous — it belongs to a session, not to an account — so this
 * is the only thing tying two requests to the same cart. The server mints the
 * value and echoes it on every response; the client stores it and sends it
 * back.
 */
export const CART_SESSION_HEADER = 'cart-session-id';

/** Reason recorded against inventory's ledger rows for each kind of move. */
export const CART_UPDATE_REASON = 'Cart updated';
export const CART_ROLLBACK_REASON = 'Rolling back a failed cart update';
