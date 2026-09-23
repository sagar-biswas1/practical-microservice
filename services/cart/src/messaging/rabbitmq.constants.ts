import { Inject } from '@nestjs/common';
import type { ChannelModel, SocketOptions } from 'amqplib';

/**
 * amqplib's `connect`, as a provider.
 *
 * Injected rather than imported so a test can hand the client a fake broker
 * and drive connection loss, nacks and confirm timeouts deterministically —
 * the same reason `HttpInventoryAdapter` takes its axios instance from
 * `INVENTORY_HTTP` instead of building one.
 */
export const AMQP_CONNECT = 'AMQP_CONNECT';

export type AmqpConnect = (
  url: string,
  socketOptions?: SocketOptions,
) => Promise<ChannelModel>;

export const InjectAmqpConnect = () => Inject(AMQP_CONNECT);
