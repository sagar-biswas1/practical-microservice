import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

import { InjectRedis } from './redis.constants';

/**
 * Releases a lock only if this caller still owns it.
 *
 * A plain DEL would let a holder whose lock had already lapsed delete the
 * lock a *later* holder is now relying on — the classic way a mutual
 * exclusion quietly stops being mutual.
 */
const LOCK_RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

type LockRedis = Redis & {
  lockRelease(key: string, token: string): Promise<number>;
};

/** Proof of ownership, and the only thing that can release the lock. */
export interface Lock {
  readonly key: string;
  readonly token: string;
}

export interface AcquireOptions {
  /** How long the lock survives if its holder dies. */
  ttlMs: number;
  /** Retries before giving up. Zero means a single attempt. */
  retries?: number;
  retryDelayMs?: number;
}

/**
 * A single-Redis advisory lock.
 *
 * Deliberately not Redlock: with one Redis instance there is nothing to
 * quorum across, and the guarantee this needs is modest — keep two writers
 * off the same cart, and keep replicas from racing to release the same
 * reservation. A lock lost to a failover costs a duplicated release, which
 * inventory reports as a conflict rather than acting on twice.
 */
@Injectable()
export class RedisLock {
  private readonly logger = new Logger(RedisLock.name);
  private readonly redis: LockRedis;

  constructor(@InjectRedis() redis: Redis) {
    redis.defineCommand('lockRelease', { numberOfKeys: 1, lua: LOCK_RELEASE });
    this.redis = redis as LockRedis;
  }

  /** Takes the lock, or returns null if someone else holds it. */
  async acquire(key: string, options: AcquireOptions): Promise<Lock | null> {
    const { ttlMs, retries = 0, retryDelayMs = 0 } = options;
    const token = randomUUID();

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const taken = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
      if (taken === 'OK') return { key, token };

      if (attempt < retries && retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    return null;
  }

  /**
   * Gives the lock back, never throwing.
   *
   * This is called from `finally` blocks, where an exception would replace
   * whatever the caller was already reporting with a less useful one. The
   * lock expires on its own regardless, so a failure here costs a delay at
   * worst.
   */
  async release(lock: Lock): Promise<void> {
    try {
      await this.redis.lockRelease(lock.key, lock.token);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`could not release lock ${lock.key}: ${message}`);
    }
  }

  /** Runs `work` under the lock, releasing it however that turns out. */
  async withLock<T>(
    key: string,
    options: AcquireOptions,
    work: () => Promise<T>,
  ): Promise<T | null> {
    const lock = await this.acquire(key, options);
    if (!lock) return null;

    try {
      return await work();
    } finally {
      await this.release(lock);
    }
  }
}
