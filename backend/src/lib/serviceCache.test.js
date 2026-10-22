import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config.js', () => ({
  default: {
    redisUrl: undefined,
    serviceCache: { ttlSeconds: 15 },
  },
}));

import {
  computeServiceEtag,
  getCachedServiceDetail,
  getServiceCacheStatus,
  getServiceCacheKey,
  _resetServiceMemoryCache,
} from './serviceCache.js';
import { getServiceCacheMetrics, resetRouteMetrics } from './routeMetrics.js';

describe('service detail cache', () => {
  beforeEach(() => {
    _resetServiceMemoryCache();
    resetRouteMetrics();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds the payload once and serves later reads from the cache', async () => {
    const load = vi.fn(() => ({ id: 1, name: 'Service 1' }));

    const first = await getCachedServiceDetail(1, load);
    const second = await getCachedServiceDetail(1, load);

    expect(load).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.body).toBe(first.body);
    expect(second.etag).toBe(first.etag);
    expect(getServiceCacheMetrics().hits).toBe(1);
    expect(getServiceCacheMetrics().misses).toBe(1);
    expect(getServiceCacheMetrics().hitRate).toBe(0.5);
  });

  it('rebuilds the payload once the TTL has passed', async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => ({ id: 1, name: 'Service 1' }));

    await getCachedServiceDetail(1, load);
    await vi.advanceTimersByTimeAsync(15_000 + 1);
    await getCachedServiceDetail(1, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('derives a stable weak ETag from the exact JSON body it serves', async () => {
    const { body, etag } = await getCachedServiceDetail(1, () => ({ id: 1, name: 'Service 1' }));

    expect(etag).toMatch(/^W\/".+"$/);
    expect(etag).toBe(computeServiceEtag(body));
    expect(computeServiceEtag(body)).toBe(computeServiceEtag(body));
  });

  it('handles not found items without caching them', async () => {
    const load = vi.fn(() => null);

    const first = await getCachedServiceDetail(404, load);
    const second = await getCachedServiceDetail(404, load);

    expect(first.notFound).toBe(true);
    expect(first.body).toBe(null);
    expect(second.notFound).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keys cache entries separately by service id', async () => {
    const load1 = vi.fn(() => ({ id: 1, name: 'One' }));
    const load2 = vi.fn(() => ({ id: 2, name: 'Two' }));

    await getCachedServiceDetail(1, load1);
    await getCachedServiceDetail(2, load2);

    expect(getServiceCacheKey(1)).toBe('lodestar:services:v1:1');
    expect(getServiceCacheKey(2)).toBe('lodestar:services:v1:2');
    expect(load1).toHaveBeenCalledTimes(1);
    expect(load2).toHaveBeenCalledTimes(1);
  });

  it('reports the configured TTL and status', () => {
    expect(getServiceCacheStatus()).toMatchObject({ ttlSeconds: 15, enabled: false });
  });
});
