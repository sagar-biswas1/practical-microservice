import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CartModule } from './cart/cart.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [RedisModule, CartModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
