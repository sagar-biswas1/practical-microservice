import { Module } from '@nestjs/common';

import { CartModule } from './cart/cart.module';
import { HealthModule } from './health/health.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [RedisModule, HealthModule, CartModule],
})
export class AppModule {}
