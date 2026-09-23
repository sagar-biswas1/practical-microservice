import { Module } from '@nestjs/common';

import { MessagingModule } from '../messaging/messaging.module';
import { HealthController } from './health.controller';

/** `RedisService` comes from the global `RedisModule`; the broker client does not. */
@Module({ imports: [MessagingModule], controllers: [HealthController] })
export class HealthModule {}
