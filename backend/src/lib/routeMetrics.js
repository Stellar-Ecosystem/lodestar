/**
 * Route-level counters, exposed at `GET /api/metrics`.
 *
 * These exist so a degraded dependency is *visible* instead of inferred from
 * error rates: an upstream timeout (#671) and a cold health cache (#672) both
 * look like "slow responses" in a log, but only a counter tells them apart.
 *
 * Counters are process-local and monotonic. They are intentionally cheap (no
 * timers, no locks) so they can be written from a request hot path.
 */

const state = {
  upstreamTimeouts: 0,
  upstreamTimeoutsByLabel: Object.create(null),
  healthCache: {
    lookups: 0,
    hits: 0,
    misses: 0,
    errors: 0,
    loads: 0,
  },
};

/**
 * Record an upstream call that exceeded its deadline.
 *
 * @param {string} label Route-scoped label, e.g. `reputation`.
 */
export function recordUpstreamTimeout(label) {
  state.upstreamTimeouts += 1;
  const key = String(label ?? 'unknown');
  state.upstreamTimeoutsByLabel[key] = (state.upstreamTimeoutsByLabel[key] ?? 0) + 1;
}

/**
 * Record a health cache lookup.
 *
 * @param {'hit'|'miss'} status
 */
export function recordHealthCacheLookup(status) {
  state.healthCache.lookups += 1;
  if (status === 'hit') {
    state.healthCache.hits += 1;
  } else {
    state.healthCache.misses += 1;
  }
}

/** Record a failure to read from or write to the cache backend. */
export function recordHealthCacheError() {
  state.healthCache.errors += 1;
}

/** Record an actual payload build (a cache miss that produced a fresh body). */
export function recordHealthCacheLoad() {
  state.healthCache.loads += 1;
}

export function getUpstreamTimeoutMetrics() {
  return {
    total: state.upstreamTimeouts,
    byLabel: { ...state.upstreamTimeoutsByLabel },
  };
}

export function getHealthCacheMetrics() {
  const { lookups, hits, misses, errors, loads } = state.healthCache;
  return {
    lookups,
    hits,
    misses,
    errors,
    loads,
    hitRate: lookups === 0 ? 0 : Number((hits / lookups).toFixed(4)),
  };
}

export function getRouteMetrics() {
  return {
    upstreamTimeouts: getUpstreamTimeoutMetrics(),
    healthCache: getHealthCacheMetrics(),
  };
}

/** Exposed for testing only — resets every counter. */
export function resetRouteMetrics() {
  state.upstreamTimeouts = 0;
  state.upstreamTimeoutsByLabel = Object.create(null);
  state.healthCache = { lookups: 0, hits: 0, misses: 0, errors: 0, loads: 0 };
}
