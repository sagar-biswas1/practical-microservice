import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { InjectRedis, InjectRedisEvents } from './redis.constants';

/**
 * Thin handle over the two connections. Inject the clients directly with
 * `@InjectRedis()` / `@InjectRedisEvents()` for real work — this exists for
 * lifecycle and health, so nothing else has to own closing the sockets.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);

  constructor(
    @InjectRedis() public readonly client: Redis,
    @InjectRedisEvents() public readonly events: Redis,
  ) {}

  /** Round-trips both connections; throws if either is unusable. */
  async ping(): Promise<{ client: string; events: string }> {
    const [client, events] = await Promise.all([
      this.client.ping(),
      // The events client answers PING even in subscriber mode.
      this.events.ping(),
    ]);

    return { client, events };
  }

  async onApplicationShutdown(): Promise<void> {
    // quit() drains in-flight commands; disconnect() would drop them. Either
    // client may already be down, in which case quit rejects — that is fine,
    // the socket is closed regardless.
    await Promise.allSettled([this.client.quit(), this.events.quit()]);
    this.logger.log('connections closed');
  }
}
