import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { withUpstreamTimeout } from './upstreamTimeout.js';
import { getRouteMetrics, resetRouteMetrics } from './routeMetrics.js';
import { UpstreamTimeoutError } from './contractErrors.js';

describe('withUpstreamTimeout (#671)', () => {
  beforeEach(() => {
    resetRouteMetrics();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the upstream value when it settles before the deadline', async () => {
    const result = await withUpstreamTimeout(Promise.resolve(42), {
      timeoutMs: 1_000,
      label: 'reputation',
    });

    expect(result).toBe(42);
    expect(getRouteMetrics().upstreamTimeouts.total).toBe(0);
  });

  it('rejects with a 504 UPSTREAM_TIMEOUT once the deadline expires', async () => {
    vi.useFakeTimers();
    const pending = withUpstreamTimeout(new Promise(() => {}), {
      timeoutMs: 5_000,
      label: 'reputation',
    });
    // Attach the handler before the clock moves, so the rejection is never
    // momentarily unhandled.
    const settled = pending.catch((err) => err);

    await vi.advanceTimersByTimeAsync(5_001);

    const err = await settled;
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    expect(err).toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
      status: 504,
      timeoutMs: 5_000,
    });
  });

  it('counts the expiry as a metric', async () => {
    vi.useFakeTimers();
    const pending = withUpstreamTimeout(new Promise(() => {}), {
      timeoutMs: 1_000,
      label: 'reputation',
    });
    const settled = pending.catch(() => {});

    await vi.advanceTimersByTimeAsync(1_001);
    await settled;

    expect(getRouteMetrics().upstreamTimeouts.total).toBe(1);
    expect(getRouteMetrics().upstreamTimeouts.byLabel.reputation).toBe(1);
  });

  it('lets an upstream failure through unchanged', async () => {
    await expect(
      withUpstreamTimeout(Promise.reject(new Error('boom')), {
        timeoutMs: 1_000,
        label: 'reputation',
      }),
    ).rejects.toThrow('boom');
  });
});
