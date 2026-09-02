import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { env } from '../config/env';
import { RedisService } from '../redis/redis.service';

/**
 * Liveness and readiness, kept apart on purpose.
 *
 * An orchestrator restarts a container that fails liveness and merely stops
 * routing to one that fails readiness. Pinging Redis on the liveness probe
 * would conflate the two: a Redis outage would roll every replica instead of
 * taking them out of the load balancer until it came back.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly redis: RedisService) {}

  /** The process is up. Nothing downstream is consulted. */
  @Get('live')
  live(): { status: string; service: string } {
    return { status: 'ok', service: env.SERVICE_NAME };
  }

  /**
   * The process can actually serve a cart, which means both connections are
   * usable — the subscriber one included, since a cart that cannot hear
   * expiries will hold stock it never hands back.
   */
  @Get('ready')
  async ready(): Promise<{ status: string; service: string; redis: unknown }> {
    try {
      return {
        status: 'ok',
        service: env.SERVICE_NAME,
        redis: await this.redis.ping(),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`readiness failed: ${message}`);
      throw new ServiceUnavailableException('Redis is unreachable');
    }
  }

  @Get()
  async check(): Promise<{ status: string; service: string; redis: unknown }> {
    return this.ready();
  }
}
