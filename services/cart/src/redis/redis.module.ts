import { Global, Logger, Module, type Provider } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { createRedisClient } from './redis.config';
import { REDIS_CLIENT, REDIS_EVENT_CLIENT } from './redis.constants';
import { RedisService } from './redis.service';

async function connect(role: 'default' | 'events'): Promise<Redis> {
  const client = createRedisClient(role);
  // Clients are lazy, so this is where a wrong host or password surfaces —
  // during bootstrap, with a clear error, instead of on the first cart write.
  await client.connect();
  new Logger('RedisModule').log(`${role} client connected`);
  return client;
}

const clientProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: () => connect('default'),
};

const eventClientProvider: Provider = {
  provide: REDIS_EVENT_CLIENT,
  useFactory: () => connect('events'),
};

/**
 * Global so feature modules can inject the clients without importing this
 * module everywhere; the connections are singletons either way.
 */
@Global()
@Module({
  providers: [clientProvider, eventClientProvider, RedisService],
  exports: [REDIS_CLIENT, REDIS_EVENT_CLIENT, RedisService],
})
export class RedisModule {}
