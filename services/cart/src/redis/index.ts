export { RedisModule } from './redis.module';
export { RedisService } from './redis.service';
export { RedisLock, type Lock, type AcquireOptions } from './redis.lock';
export {
  InjectRedis,
  InjectRedisEvents,
  REDIS_CLIENT,
  REDIS_EVENT_CLIENT,
} from './redis.constants';
