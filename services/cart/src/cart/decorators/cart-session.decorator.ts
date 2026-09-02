import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { CART_SESSION_HEADER } from '../cart.constants';

/**
 * The cart session the client claims, or null.
 *
 * Claimed, not verified: whether the session still exists is the service's
 * question, and a client is free to send one that has long since expired.
 *
 * Node hands back an array when a header arrives more than once, which the
 * `as string` casts this replaces would have quietly passed on to Redis as a
 * key. Taking the first value is the same thing Express does for its own
 * header lookups.
 */
export const CartSessionId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null =>
    header(ctx.switchToHttp().getRequest<Request>(), CART_SESSION_HEADER),
);

export function header(request: Request, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}
