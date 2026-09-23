import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

import { env } from '../config/env';
import type { BrokerStatus } from '../messaging/messaging.types';
import { RabbitMqClient } from '../messaging/rabbitmq.client';
import { RedisService } from '../redis/redis.service';

interface Readiness {
  status: string;
  service: string;
  redis: unknown;
  broker: BrokerStatus;
}

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

  constructor(
    private readonly redis: RedisService,
    private readonly broker: RabbitMqClient,
  ) {}

  /** The process is up. Nothing downstream is consulted. */
  @Get('live')
  live(): { status: string; service: string } {
    return { status: 'ok', service: env.SERVICE_NAME };
  }

  /**
   * The process can actually serve a cart, which means both Redis connections
   * are usable — the subscriber one included, since a cart that cannot hear
   * expiries will hold stock it never hands back.
   *
   * The broker is *reported* but does not gate readiness. Losing it only
   * delays the fire-and-forget releases, which the sweeper retries; failing
   * readiness on it would take every replica out of the load balancer over a
   * dependency the shopper-facing path never touches.
   */
  @Get('ready')
  async ready(): Promise<Readiness> {
    try {
      return {
        status: 'ok',
        service: env.SERVICE_NAME,
        redis: await this.redis.ping(),
        broker: this.broker.status(),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`readiness failed: ${message}`);
      throw new ServiceUnavailableException('Redis is unreachable');
    }
  }

  @Get()
  async check(): Promise<Readiness> {
    return this.ready();
  }
}
