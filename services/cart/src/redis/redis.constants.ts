import { Inject } from '@nestjs/common';

/**
 * The general-purpose client: GET/SET/HSET, stream writes, everything that is
 * a normal request/response command.
 */
export const REDIS_CLIENT = 'REDIS_CLIENT';

/**
 * The event client. It is kept separate because a connection in subscriber
 * mode can only run (P)SUBSCRIBE/UNSUBSCRIBE — every other command on it is
 * rejected by Redis — and because blocking reads (BRPOP, XREAD BLOCK) park the
 * connection for as long as they wait. Either one would stall normal traffic
 * if it shared a socket with it.
 *
 * Note: ioredis applies `keyPrefix` to key arguments only. Channel names in
 * SUBSCRIBE/PUBLISH are not keys and stay unprefixed — prefix them yourself if
 * you want them namespaced. Stream keys used with XREAD *are* prefixed.
 */
export const REDIS_EVENT_CLIENT = 'REDIS_EVENT_CLIENT';

/** Injects the general-purpose client. */
export const InjectRedis = () => Inject(REDIS_CLIENT);

/** Injects the subscriber/consumer client. */
export const InjectRedisEvents = () => Inject(REDIS_EVENT_CLIENT);
