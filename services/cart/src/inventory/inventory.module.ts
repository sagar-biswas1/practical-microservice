import { Module, type Provider } from '@nestjs/common';
import axios from 'axios';

import { env } from '../config/env';
import { AmqpInventoryDispatch } from './inventory.amqp.adapter';
import { INVENTORY_HTTP } from './inventory.constants';
import { HttpInventoryAdapter } from './inventory.http.adapter';
import { INVENTORY_DISPATCH, INVENTORY_PORT } from './inventory.port';

const httpProvider: Provider = {
  provide: INVENTORY_HTTP,
  useFactory: () =>
    axios.create({
      baseURL: env.INVENTORY_SERVICE_URL,
      timeout: env.INVENTORY_TIMEOUT_MS,
      headers: { accept: 'application/json' },
      // Every status is a normal response; only transport failures reject.
      // Status handling then lives in one place in the adapter instead of
      // being split between the happy path and an error interceptor.
      validateStatus: () => true,
    }),
};

/**
 * The request/response half. Not switchable — a shopper has to be told now
 * whether the stock exists, and no broker changes that.
 */
const portProvider: Provider = {
  provide: INVENTORY_PORT,
  useExisting: HttpInventoryAdapter,
};

/**
 * The fire-and-forget half, and the only thing
 * `INVENTORY_DISPATCH_TRANSPORT` moves.
 *
 * `useExisting` on the HTTP path rather than a second instance: the same
 * adapter serves both ports while the transport is `http`, so a release still
 * shares the connection pool and the error translation with everything else.
 */
const dispatchProvider: Provider = {
  provide: INVENTORY_DISPATCH,
  useFactory: (http: HttpInventoryAdapter, amqp: AmqpInventoryDispatch) =>
    env.INVENTORY_DISPATCH_TRANSPORT === 'amqp' ? amqp : http,
  inject: [HttpInventoryAdapter, AmqpInventoryDispatch],
};

/**
 * The cart's outbound dependency on the inventory service.
 *
 * Not `@Global()`, unlike RedisModule: a module that reserves stock should
 * have to say so by importing this, since that is the edge where a cart can
 * start holding units it may later have to hand back.
 */
@Module({
  providers: [
    httpProvider,
    HttpInventoryAdapter,
    AmqpInventoryDispatch,
    portProvider,
    dispatchProvider,
  ],
  exports: [INVENTORY_PORT, INVENTORY_DISPATCH],
})
export class InventoryModule {}
