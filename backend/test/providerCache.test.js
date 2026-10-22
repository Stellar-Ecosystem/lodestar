import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisState = vi.hoisted(() => ({ values: new Map(), instance: null }));
const originalRedisUrl = process.env.REDIS_URL;
const originalCacheTtl = process.env.REGISTRY_CACHE_TTL_SECONDS;

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
    async del(key) {
      redisState.values.delete(key);
      return 1;
    }
  },
}));

describe('provider services cache', () => {
  let cache;
  const PROVIDER = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';

  beforeEach(async () => {
    vi.resetModules();
    redisState.values.clear();
    redisState.ttl = undefined;
    process.env.REDIS_URL = 'redis://cache.test';
    process.env.REGISTRY_CACHE_TTL_SECONDS = '42';
    cache = await import('../src/lib/providerCache.js');
    cache.resetProviderCacheMetrics();
  });

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalCacheTtl === undefined) delete process.env.REGISTRY_CACHE_TTL_SECONDS;
    else process.env.REGISTRY_CACHE_TTL_SECONDS = originalCacheTtl;
  });

  it('reuses cached provider services for the configured short TTL', async () => {
    const mockServices = { services: [{ id: 1, name: 'Service 1' }], count: 1 };
    const loadServices = vi.fn().mockResolvedValue(mockServices);

    const first = await cache.getCachedServicesByProvider(PROVIDER, loadServices);
    expect(first).toEqual(mockServices);

    const second = await cache.getCachedServicesByProvider(PROVIDER, loadServices);
    expect(second).toEqual(mockServices);

    expect(loadServices).toHaveBeenCalledTimes(1);
    expect(redisState.ttl).toBe(42);
    expect(cache.getProviderCacheMetrics()).toMatchObject({
      lookups: 2,
      hits: 1,
      misses: 1,
      errors: 0,
      hitRate: 0.5,
      ttlSeconds: 42,
      enabled: true,
    });
  });

  it('falls back to loadServices when Redis is disabled', async () => {
    delete process.env.REDIS_URL;
    vi.resetModules();
    const disabledCache = await import('../src/lib/providerCache.js');
    disabledCache.resetProviderCacheMetrics();

    const mockServices = { services: [], count: 0 };
    const loadServices = vi.fn().mockResolvedValue(mockServices);

    const result = await disabledCache.getCachedServicesByProvider(PROVIDER, loadServices);
    expect(result).toEqual(mockServices);
    expect(loadServices).toHaveBeenCalledTimes(1);
    expect(disabledCache.getProviderCacheMetrics()).toMatchObject({
      lookups: 1,
      hits: 0,
      misses: 1,
      errors: 0,
      hitRate: 0,
      enabled: false,
    });
  });

  it('handles Redis read errors gracefully without failing request', async () => {
    const mockServices = { services: [{ id: 2 }], count: 1 };
    const loadServices = vi.fn().mockResolvedValue(mockServices);

    const errorRedis = {
      get: vi.fn().mockRejectedValue(new Error('Redis connection lost')),
      set: vi.fn().mockResolvedValue('OK'),
    };
    cache.setProviderCacheRedis(errorRedis);

    const result = await cache.getCachedServicesByProvider(PROVIDER, loadServices);
    expect(result).toEqual(mockServices);
    expect(loadServices).toHaveBeenCalledTimes(1);

    const metrics = cache.getProviderCacheMetrics();
    expect(metrics.errors).toBe(1);
    expect(metrics.misses).toBe(1);
    expect(metrics.hits).toBe(0);
    expect(metrics.hitRate).toBe(0);
  });

  it('handles Redis write errors gracefully without failing request', async () => {
    const mockServices = { services: [{ id: 3 }], count: 1 };
    const loadServices = vi.fn().mockResolvedValue(mockServices);

    const errorRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockRejectedValue(new Error('Redis readonly')),
    };
    cache.setProviderCacheRedis(errorRedis);

    const result = await cache.getCachedServicesByProvider(PROVIDER, loadServices);
    expect(result).toEqual(mockServices);
    expect(loadServices).toHaveBeenCalledTimes(1);

    const metrics = cache.getProviderCacheMetrics();
    expect(metrics.errors).toBe(1);
    expect(metrics.misses).toBe(1);
    expect(metrics.hits).toBe(0);
    expect(metrics.hitRate).toBe(0);
  });

  it('invalidates cached provider entry on demand', async () => {
    const mockServices = { services: [{ id: 1 }], count: 1 };
    const loadServices = vi.fn().mockResolvedValue(mockServices);

    await cache.getCachedServicesByProvider(PROVIDER, loadServices);
    expect(redisState.values.has(cache.getProviderCacheKey(PROVIDER))).toBe(true);

    await cache.invalidateProviderCache(PROVIDER);
    expect(redisState.values.has(cache.getProviderCacheKey(PROVIDER))).toBe(false);
  });
});
