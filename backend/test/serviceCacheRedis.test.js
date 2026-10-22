import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisState = vi.hoisted(() => ({ values: new Map(), instance: null, ttl: undefined }));
const originalRedisUrl = process.env.REDIS_URL;
const originalTtl = process.env.SERVICE_CACHE_TTL_SECONDS;

vi.mock('ioredis', () => ({
  Redis: class {
    constructor() {
      redisState.instance = this;
    }
    on() {}
    async get(key) {
      return redisState.values.get(key) ?? null;
    }
    async set(key, value, _expiry, ttl) {
      redisState.values.set(key, value);
      redisState.ttl = ttl;
      return 'OK';
    }
  },
}));

describe('serviceCache with Redis', () => {
  let cache;

  beforeEach(async () => {
    vi.resetModules();
    redisState.values.clear();
    redisState.ttl = undefined;
    process.env.REDIS_URL = 'redis://cache.test';
    process.env.SERVICE_CACHE_TTL_SECONDS = '23';
    cache = await import('../src/lib/serviceCache.js');
  });

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;

    if (originalTtl === undefined) delete process.env.SERVICE_CACHE_TTL_SECONDS;
    else process.env.SERVICE_CACHE_TTL_SECONDS = originalTtl;
  });

  it('stores and retrieves service payload from Redis with configured TTL', async () => {
    cache._resetServiceMemoryCache();

    const load = vi.fn(async () => ({ id: 4, name: 'Redis Service' }));

    const first = await cache.getCachedServiceDetail(4, load);
    expect(first.cached).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);

    expect(redisState.ttl).toBe(23);
    expect(redisState.values.has('lodestar:services:v1:4')).toBe(true);

    const second = await cache.getCachedServiceDetail(4, load);
    expect(second.cached).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(JSON.parse(second.body)).toEqual({ id: 4, name: 'Redis Service' });
  });

  it('falls back gracefully to upstream when Redis get throws', async () => {
    cache._resetServiceMemoryCache();

    vi.spyOn(redisState.instance, 'get').mockRejectedValueOnce(new Error('Redis connection lost'));

    const load = vi.fn(async () => ({ id: 5, name: 'Fallback Service' }));
    const result = await cache.getCachedServiceDetail(5, load);

    expect(result.cached).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.body)).toEqual({ id: 5, name: 'Fallback Service' });
  });
});
