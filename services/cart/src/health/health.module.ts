import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/** `RedisService` comes from the global `RedisModule`. */
@Module({ controllers: [HealthController] })
export class HealthModule {}
