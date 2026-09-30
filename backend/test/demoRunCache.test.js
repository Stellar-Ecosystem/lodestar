import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisState = vi.hoisted(() => ({ values: new Map(), instance: null }));
const originalRedisUrl = process.env.REDIS_URL;
const originalCacheTtl = process.env.DEMO_RUN_CACHE_TTL_SECONDS;

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

describe('demo-run service cache', () => {
  let cache;

  beforeEach(async () => {
    vi.resetModules();
    redisState.values.clear();
    redisState.ttl = undefined;
    process.env.REDIS_URL = 'redis://cache.test';
    process.env.DEMO_RUN_CACHE_TTL_SECONDS = '23';
    cache = await import('../src/lib/demoRunCache.js');
  });

  afterEach(() => {
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalCacheTtl === undefined) delete process.env.DEMO_RUN_CACHE_TTL_SECONDS;
    else process.env.DEMO_RUN_CACHE_TTL_SECONDS = originalCacheTtl;
  });

  it('reuses a cached service record for the configured short TTL', async () => {
    const loadService = vi.fn().mockResolvedValue({ id: 4, endpoint: 'https://demo.test' });

    await expect(cache.getCachedService(4, loadService)).resolves.toEqual({
      id: 4,
      endpoint: 'https://demo.test',
    });
    await expect(cache.getCachedService(4, loadService)).resolves.toEqual({
      id: 4,
      endpoint: 'https://demo.test',
    });

    expect(loadService).toHaveBeenCalledTimes(1);
    expect(redisState.ttl).toBe(23);
    expect(cache.getDemoCacheMetrics()).toMatchObject({ lookups: 2, hits: 1, misses: 1 });
  });
});
