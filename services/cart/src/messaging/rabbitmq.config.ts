import type { SocketOptions } from 'amqplib';

import { env } from '../config/env';

/**
 * The URL amqplib connects to.
 *
 * The heartbeat rides on the URL because that is the one place amqplib reads
 * it from when given a string; an explicit `?heartbeat=` in `RABBITMQ_URL`
 * wins over the env default. Without a heartbeat a half-open TCP connection
 * — a NAT timeout, a broker that vanished without a FIN — is discovered only
 * on the next publish, which then hangs for the whole publish timeout.
 */
export function connectionUrl(url: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('heartbeat')) {
    parsed.searchParams.set(
      'heartbeat',
      String(env.RABBITMQ_HEARTBEAT_SECONDS),
    );
  }
  return parsed.toString();
}

export function socketOptions(): SocketOptions {
  return {
    // Connection *establishment* timeout. Without it a firewall that drops
    // SYNs silently holds bootstrap for the OS default, which is minutes.
    timeout: env.RABBITMQ_CONNECT_TIMEOUT_MS,
    // Shows up in the management UI's connection list, which is the
    // difference between "some connection is stuck" and knowing whose.
    clientProperties: {
      connection_name: `${env.SERVICE_NAME}:publisher`,
    },
  };
}

/**
 * Backoff between reconnect attempts: linear, capped. Reconnects are retried
 * forever; a cart that lost its broker should pick it back up on its own
 * once the broker returns rather than needing a restart — the same policy
 * the Redis clients follow.
 */
export function reconnectDelay(attempt: number): number {
  return Math.min(attempt * 500, env.RABBITMQ_MAX_RETRY_DELAY_MS);
}

/** `host:port/vhost`, credentials stripped, for logs and health. */
export function describeBroker(url: string): string {
  try {
    const parsed = new URL(url);
    const port =
      parsed.port || (parsed.protocol === 'amqps:' ? '5671' : '5672');
    const vhost = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || '/';
    return `${parsed.hostname}:${port}${vhost === '/' ? '/' : `/${vhost}`}`;
  } catch {
    return 'rabbitmq';
  }
}
