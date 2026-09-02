import { Module } from '@nestjs/common';

import { InventoryModule } from '../inventory/inventory.module';
import { CartController } from './cart.controller';
import { CartExpiryWatcher } from './cart-expiry.watcher';
import { CartKeys } from './cart.keys';
import { CartRepository } from './cart.repository';
import { CartService } from './cart.service';

/**
 * `InventoryClient` is not listed as a provider here on purpose: it comes from
 * `InventoryModule`, which exports it. Declaring it again would build a second
 * instance in this module's injector, where the `INVENTORY_HTTP` token it
 * depends on is not available. `RedisLock` likewise comes from the global
 * `RedisModule`.
 */
@Module({
  imports: [InventoryModule],
  controllers: [CartController],
  providers: [CartService, CartRepository, CartExpiryWatcher, CartKeys],
  exports: [CartService],
})
export class CartModule {}
