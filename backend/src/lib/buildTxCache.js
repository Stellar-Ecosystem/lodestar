import crypto from 'node:crypto';

/**
 * Short-TTL Redis-backed cache for `POST /agents/:address/build-tx`.
 *
 * TTL is configurable via the `BUILD_TX_CACHE_TTL_SECONDS` environment
 * variable (default: 30 seconds). Set it to `0` to disable caching.
 *
 * Metrics: cache hit/miss counters are exposed via `getBuildTxCacheMetrics`
 * and are incremented in Redis so they are shared across instances.
 */

const METRICS_HIT_KEY = 'metrics:build-tx:cache:hits';
const METRICS_MISS_KEY = 'metrics:build-tx:cache:misses';

const DEFAULT_TTL_SECONDS = 30;

function readTTLSeconds() {
  const raw = process.env.BUILD_TX_CACHE_TTL_SECONDS;
  if (raw === undefined || raw === '') {
    return DEFAULT_TTL_SECONDS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TTL_SECONDS;
  }
  return parsed;
}

export function getBuildTxCacheTTLSeconds() {
  return readTTLSeconds();
}

export function isBuildTxCacheEnabled() {
  return readTTLSeconds() > 0;
}

/*
 * Stable, deterministic serialization of request params so that the
 * cache key is identical for equivalent requests.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function buildTxCacheKey(address, params) {
  const normalizedAddress = String(address).toLowerCase();
  const payload = stableStringify(params || {});
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  return `build-tx:${normalizedAddress}:${hash}`;
}

export function computeEtag(bodyBuffer) {
  const hash = crypto.createHash('sha256').update(bodyBuffer).digest('hex');
  return `W/"${hash}"`;
}

function safeIncr(redis, key) {
  if (!redis || typeof redis.incr !== 'function') {
    return Promise.resolve();
  }
  return Promise.resolve(redis.incr(key)).catch(() => undefined);
}

export async function recordCacheHit(redis) {
  await safeIncr(redis, METRICS_HIT_KEY);
}

export async function recordCacheMiss(redis) {
  await safeIncr(redis, METRICS_MISS_KEY);
}

export async function getBuildTxCacheMetrics(redis) {
  if (!redis) {
    return { hits: 0, misses: 0, hitRate: 0 };
  }
  const [hitsRaw, missesRaw] = await Promise.all([
    Promise.resolve(redis.get(METRICS_HIT_KEY)).catch(() => null),
    Promise.resolve(redis.get(METRICS_MISS_KEY)).catch(() => null),
  ]);
  const hits = Number(hitsRaw) || 0;
  const misses = Number(missesRaw) || 0;
  const total = hits + misses;
  return {
    hits,
    misses,
    hitRate: total > 0 ? hits / total : 0,
  };
}

export async function getCachedEntry(redis, key) {
  if (!redis || typeof redis.get !== 'function') {
    return null;
  }
  const raw = await redis.get(key);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.body !== 'string') {
      return null;
    }
    return {
      bodyBuffer: Buffer.from(parsed.body, 'base64'),
      etag: parsed.etag,
    };
  } catch {
    return null;
  }
}

export async function setCachedEntry(redis, key, bodyBuffer, etag, ttlSeconds) {
  if (!redis || typeof redis.set !== 'function') {
    return;
  }
  if (!ttlSeconds || ttlSeconds <= 0) {
    return;
  }
  const payload = JSON.stringify({
    body: bodyBuffer.toString('base64'),
    etag,
  });
  await redis.set(key, payload, 'EX', Math.ceil(ttlSeconds));
}
