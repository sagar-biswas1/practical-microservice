import { Logger } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';

import { env } from '../config/env';

export type RedisRole = 'default' | 'events';

/**
 * Options shared by both connections. Anything role-specific is layered on top
 * in `createRedisClient`.
 */
function baseOptions(role: RedisRole): RedisOptions {
  return {
    // Shows up in CLIENT LIST / MONITOR, which is the difference between
    // "some cart connection is stuck" and knowing which of the two it is.
    connectionName: `${env.SERVICE_NAME}:${role}`,
    keyPrefix: env.REDIS_KEY_PREFIX,
    // Reconnect forever with a capped exponential-ish backoff.
    retryStrategy: (times) =>
      Math.min(times * 200, env.REDIS_MAX_RETRY_DELAY_MS),
    // Nest owns startup ordering: connect explicitly in the module factory so
    // a bad config fails the bootstrap instead of the first request.
    lazyConnect: true,
  };
}

function connectionOptions(): RedisOptions {
  if (env.REDIS_URL) {
    // Host, port, credentials and db all come from the URL itself.
    return {};
  }

  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    ...(env.REDIS_USERNAME ? { username: env.REDIS_USERNAME } : {}),
    ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
    db: env.REDIS_DB,
    ...(env.REDIS_TLS ? { tls: {} } : {}),
  };
}

function roleOptions(role: RedisRole): RedisOptions {
  if (role !== 'events') return {};

  return {
    // A blocking XREAD/BRPOP outlives the default 20-retry request budget: with
    // a number here ioredis errors the pending command on reconnect. `null`
    // lets it hang until the connection is genuinely back.
    maxRetriesPerRequest: null,
    // The ready check runs INFO, which a connection already in subscriber mode
    // cannot answer.
    enableReadyCheck: false,
  };
}

export function createRedisClient(role: RedisRole): Redis {
  const options: RedisOptions = {
    ...baseOptions(role),
    ...connectionOptions(),
    ...roleOptions(role),
  };

  const client = env.REDIS_URL
    ? new Redis(env.REDIS_URL, options)
    : new Redis(options);

  const logger = new Logger(`Redis:${role}`);

  // Without a listener, ioredis re-emits connection failures as unhandled
  // 'error' events and takes the process down mid-reconnect.
  client.on('error', (error: Error) => logger.error(error.message));
  client.on('reconnecting', () => logger.warn('reconnecting'));
  client.on('ready', () => logger.log('ready'));
  client.on('end', () => logger.warn('connection closed'));

  return client;
}
