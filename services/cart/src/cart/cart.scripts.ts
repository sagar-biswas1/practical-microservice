import type { Redis } from 'ioredis';

/**
 * The multi-key steps of a cart's lifetime, as Lua.
 *
 * Two reasons they are scripts rather than pipelines. Atomicity: a commit
 * touches three keys and a half-applied one leaves the cart disagreeing with
 * the units inventory is holding. And round trips: a commit is a single call
 * regardless of how many lines changed, where the queued-command version cost
 * one per line and still could not be atomic.
 *
 * `defineCommand` is what makes them safe to use alongside `keyPrefix` —
 * ioredis prefixes the declared `KEYS` exactly as it does for a normal
 * command, and falls back from EVALSHA to EVAL on its own when a connection
 * has not seen the script yet.
 */

/**
 * Writes the settled cart, re-arms both TTLs, and returns the result.
 *
 * KEYS: items hash, session sentinel, due index.
 * ARGV: sessionId, sessionTtl, itemsTtl, dueAtMs, pairCount, then `pairCount`
 * field/value pairs to write, then any fields to remove.
 *
 * A cart that ends up empty takes its session and its due entry with it:
 * there is nothing left to hold, so leaving a sentinel behind would only
 * schedule a release of nothing.
 */
const CART_COMMIT = `
local unpack = unpack or table.unpack
local pairCount = tonumber(ARGV[5])
local cursor = 5

if pairCount > 0 then
  local sets = {}
  for i = 1, pairCount * 2 do
    sets[i] = ARGV[cursor + i]
  end
  redis.call('HSET', KEYS[1], unpack(sets))
end
cursor = cursor + pairCount * 2

local removals = {}
for i = cursor + 1, #ARGV do
  removals[#removals + 1] = ARGV[i]
end
if #removals > 0 then
  redis.call('HDEL', KEYS[1], unpack(removals))
end

if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
  redis.call('ZADD', KEYS[3], ARGV[4], ARGV[1])
else
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[3], ARGV[1])
end

return redis.call('HGETALL', KEYS[1])
`;

/**
 * Slides the whole cart's expiry forward, or reports that it is already gone.
 *
 * KEYS: session sentinel, items hash, due index.
 * ARGV: sessionId, sessionTtl, itemsTtl, dueAtMs. Returns 1 when the cart is
 * still live.
 *
 * EXPIRE answers 0 for a key that does not exist, so the touch and the
 * liveness check are the same command rather than a GET followed by a race.
 */
const CART_TOUCH = `
if redis.call('EXPIRE', KEYS[1], ARGV[2]) == 0 then
  return 0
end

if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('EXPIRE', KEYS[2], ARGV[3])
  redis.call('ZADD', KEYS[3], ARGV[4], ARGV[1])
end

return 1
`;

/**
 * Reads the lines to hand back and keeps them alive while that happens.
 *
 * KEYS: items hash. ARGV: how long to hold it for.
 *
 * Deliberately not a read-and-delete: if this process dies between here and
 * inventory acknowledging the release, the hash is the only thing that can
 * tell the next attempt what was owed. The cost is that a release whose
 * response was lost gets retried, which inventory reports as a 409 — cheaper
 * than losing the record entirely.
 */
const CART_TAKE = `
local items = redis.call('HGETALL', KEYS[1])
if #items > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return items
`;

/**
 * Retires a cart once inventory has confirmed the release.
 *
 * KEYS: items hash, due index. ARGV: sessionId.
 */
const CART_FINISH = `
redis.call('DEL', KEYS[1])
return redis.call('ZREM', KEYS[2], ARGV[1])
`;

/**
 * The client with the cart scripts attached.
 *
 * `defineCommand` adds methods at runtime that TypeScript cannot see, so this
 * is the declaration of what those calls look like. Keys come first, as many
 * as the script's `numberOfKeys`; everything after is ARGV.
 */
export type CartRedis = Redis & {
  /** Returns the settled cart as a flat HGETALL reply. */
  cartCommit(
    itemsKey: string,
    sessionKey: string,
    dueKey: string,
    ...args: Array<string | number>
  ): Promise<string[]>;

  cartTouch(
    sessionKey: string,
    itemsKey: string,
    dueKey: string,
    cartSessionId: string,
    sessionTtlSeconds: number,
    itemsTtlSeconds: number,
    dueAtMs: number,
  ): Promise<number>;

  /** Returns the held lines as a flat HGETALL reply. */
  cartTake(itemsKey: string, inFlightSeconds: number): Promise<string[]>;

  cartFinish(
    itemsKey: string,
    dueKey: string,
    cartSessionId: string,
  ): Promise<number>;
};

/**
 * Attaches the scripts to a connection. Idempotent, so a second call — from
 * another provider sharing the same client — simply redefines them.
 */
export function registerCartScripts(redis: Redis): CartRedis {
  redis.defineCommand('cartCommit', { numberOfKeys: 3, lua: CART_COMMIT });
  redis.defineCommand('cartTouch', { numberOfKeys: 3, lua: CART_TOUCH });
  redis.defineCommand('cartTake', { numberOfKeys: 1, lua: CART_TAKE });
  redis.defineCommand('cartFinish', { numberOfKeys: 2, lua: CART_FINISH });

  return redis as CartRedis;
}
