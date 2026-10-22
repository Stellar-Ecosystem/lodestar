import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config.js', () => ({
  default: {
    redisUrl: undefined,
    health: { cacheTtlSeconds: 5 },
  },
}));

import { computeHealthEtag, getCachedHealth, getHealthCacheStatus, _resetMemoryCache } from './healthCache.js';
import { getHealthCacheMetrics, resetRouteMetrics } from './routeMetrics.js';

describe('health cache (#672)', () => {
  beforeEach(() => {
    _resetMemoryCache();
    resetRouteMetrics();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds the payload once and serves later reads from the cache', async () => {
    const load = vi.fn(() => ({ status: 'ok' }));

    const first = await getCachedHealth(load);
    const second = await getCachedHealth(load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(second.body).toBe(first.body);
    expect(getHealthCacheMetrics().hits).toBe(1);
    expect(getHealthCacheMetrics().misses).toBe(1);
  });

  it('rebuilds the payload once the TTL has passed', async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => ({ status: 'ok' }));

    await getCachedHealth(load);
    await vi.advanceTimersByTimeAsync(5_000 + 1);
    await getCachedHealth(load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('derives a stable ETag from the exact body it serves', async () => {
    const { body, etag } = await getCachedHealth(() => ({ status: 'ok' }));

    expect(etag).toMatch(/^W\/".+"$/);
    expect(etag).toBe(computeHealthEtag(body));
    expect(computeHealthEtag(body)).toBe(computeHealthEtag(body));
  });

  it('reports the configured TTL', () => {
    expect(getHealthCacheStatus()).toMatchObject({ ttlSeconds: 5, enabled: false });
  });
});
