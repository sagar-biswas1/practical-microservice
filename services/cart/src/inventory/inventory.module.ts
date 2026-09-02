import { Module, type Provider } from '@nestjs/common';
import axios from 'axios';

import { env } from '../config/env';
import { InventoryClient } from './inventory.client';
import { INVENTORY_HTTP } from './inventory.constants';

const httpProvider: Provider = {
  provide: INVENTORY_HTTP,
  useFactory: () =>
    axios.create({
      baseURL: env.INVENTORY_SERVICE_URL,
      timeout: env.INVENTORY_TIMEOUT_MS,
      headers: { accept: 'application/json' },
      // Every status is a normal response; only transport failures reject.
      // Status handling then lives in one place in the client instead of
      // being split between the happy path and an error interceptor.
      validateStatus: () => true,
    }),
};

/**
 * The cart's outbound dependency on the inventory service.
 *
 * Not `@Global()`, unlike RedisModule: a module that reserves stock should
 * have to say so by importing this, since that is the edge where a cart can
 * start holding units it may later have to hand back.
 */
@Module({
  providers: [httpProvider, InventoryClient],
  exports: [InventoryClient],
})
export class InventoryModule {}
