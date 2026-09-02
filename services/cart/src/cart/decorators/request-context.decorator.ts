import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { CallContext } from '../../inventory';
import { header } from './cart-session.decorator';

/** Correlation id, propagated so one id spans the whole call chain. */
const REQUEST_ID_HEADER = 'x-request-id';

/** Who to attribute the change to in inventory's audit trail. */
const ACTOR_HEADER = 'x-actor-id';

/**
 * Identity and correlation carried in from the gateway, for passing on to
 * inventory.
 *
 * Both headers are taken as given. The gateway is the only hop that talks to
 * untrusted clients and it decides their values — an actor it did not
 * authenticate is stripped there, not here.
 */
export const RequestContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CallContext => {
    const request = ctx.switchToHttp().getRequest<Request>();

    return {
      requestId: header(request, REQUEST_ID_HEADER) ?? undefined,
      actor: header(request, ACTOR_HEADER) ?? undefined,
    };
  },
);
