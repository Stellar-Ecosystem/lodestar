import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisState = vi.hoisted(() => ({ values: new Map(), instance: null }));
const originalRedisUrl = process.env.REDIS_URL;
const originalCacheTtl = process.env.CAN_SPEND_CACHE_TTL_SECONDS;

vi.mock('ioredis', () => ({
  Redis: class {
    constructor() {
      redisState.instance = this;
    }
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

describe('can-spend cache unit tests', () => {
  let cache;

  beforeEach(async () => {
    vi.resetModules();
    redisState.values.clear();
    redisState.ttl = undefined;
    process.env.REDIS_URL = 'redis://cache.test';
    process.env.CAN_SPEND_CACHE_TTL_SECONDS = '25';
    cache = await import('../src/lib/canSpendCache.js');
    cache.resetCanSpendCacheMetrics();
  });

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalCacheTtl === undefined) delete process.env.CAN_SPEND_CACHE_TTL_SECONDS;
    else process.env.CAN_SPEND_CACHE_TTL_SECONDS = originalCacheTtl;
  });

  it('builds a cache key from address and route parameters', () => {
    const key = cache.buildCanSpendCacheKey('GBOWTEST', '0.005', 'weather');
    expect(key).toBe('lodestar:can-spend:v1:GBOWTEST:0.005:weather');
  });

  it('reuses cached evaluation result for the configured short TTL', async () => {
    const compute = vi.fn().mockResolvedValue({ allowed: true, reason: 'OK' });

    const first = await cache.getCachedCanSpend('GBOWTEST', '0.001', 'weather', compute);
    expect(first).toEqual({ allowed: true, reason: 'OK' });

    const second = await cache.getCachedCanSpend('GBOWTEST', '0.001', 'weather', compute);
    expect(second).toEqual({ allowed: true, reason: 'OK' });

    expect(compute).toHaveBeenCalledTimes(1);
    expect(redisState.ttl).toBe(25);
    expect(cache.getCanSpendCacheMetrics()).toMatchObject({
      lookups: 2,
      hits: 1,
      misses: 1,
      hitRate: 0.5,
      ttlSeconds: 25,
      enabled: true,
    });
  });

  it('differentiates cache keys by route parameters', async () => {
    const compute1 = vi.fn().mockResolvedValue({ allowed: true, reason: 'OK' });
    const compute2 = vi.fn().mockResolvedValue({ allowed: false, reason: 'Limit exceeded' });

    await cache.getCachedCanSpend('GBOWTEST', '0.001', 'weather', compute1);
    await cache.getCachedCanSpend('GBOWTEST', '100', 'weather', compute2);

    expect(compute1).toHaveBeenCalledTimes(1);
    expect(compute2).toHaveBeenCalledTimes(1);
    expect(cache.getCanSpendCacheMetrics()).toMatchObject({
      lookups: 2,
      hits: 0,
      misses: 2,
      hitRate: 0,
    });
  });

  it('falls back to compute when redis get fails', async () => {
    const compute = vi.fn().mockResolvedValue({ allowed: true, reason: 'OK' });
    vi.spyOn(redisState.instance, 'get').mockRejectedValueOnce(new Error('Redis connection lost'));

    const result = await cache.getCachedCanSpend('GBOWTEST', '0.001', 'weather', compute);
    expect(result).toEqual({ allowed: true, reason: 'OK' });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.getCanSpendCacheMetrics().errors).toBe(1);
  });
});
