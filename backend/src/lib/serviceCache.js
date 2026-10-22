/**
 * Short-TTL cache for GET /api/services/:id.
 *
 * `GET /api/services/:id` serves service data that changes far less often than it
 * is read. The payload is therefore cached with a configurable short TTL — in Redis
 * when `REDIS_URL` is set so replicas share one copy, with an in-process fallback —
 * and served with `Cache-Control` + `ETag` so conditional requests can be answered
 * with 304 without re-fetching from RPC.
 *
 * The cache is best-effort by design: if Redis is unavailable the route falls
 * back to the in-process copy or upstream rather than failing.
 */

import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import config from '../config.js';
import logger from './logger.js';
import {
  recordServiceCacheError,
  recordServiceCacheLoad,
  recordServiceCacheLookup,
} from './routeMetrics.js';

/** Cache key prefix — namespaced and versioned. Keyed on route and parameters. */
const CACHE_KEY_PREFIX = 'lodestar:services:v1:';

/** @type {Map<string, { value: string, expiresAt: number }>} */
const memoryCache = new Map();

/**
 * @type {import('ioredis').Redis | undefined}
 *
 * `enableOfflineQueue: false` + `retryStrategy: () => null` make an
 * unreachable Redis fail fast instead of parking the request in a queue while
 * the client reconnects.
 */
const redis = config.redisUrl
  ? new Redis(config.redisUrl, {
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    })
  : undefined;

if (redis) {
  redis.on('error', (err) => {
    logger.warn({ err }, 'Service cache Redis client error');
  });
}

/**
 * Weak ETag over the exact JSON bytes sent to the client, so a
 * conditional request can be answered with 304 without re-serialising.
 *
 * @param {string} body
 * @returns {string}
 */
export function computeServiceEtag(body) {
  return `W/"${createHash('sha256').update(body).digest('hex')}"`;
}

export function ttlSeconds() {
  return config.serviceCache?.ttlSeconds ?? 15;
}

export function getServiceCacheKey(id) {
  return `${CACHE_KEY_PREFIX}${id}`;
}

async function readCache(key) {
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw !== null) return raw;
    } catch (err) {
      recordServiceCacheError();
      logger.warn({ err, key }, 'Service cache read failed; using the in-process copy');
    }
  }

  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value;
}

async function writeCache(key, body) {
  const ttl = ttlSeconds();
  memoryCache.set(key, { value: body, expiresAt: Date.now() + ttl * 1000 });

  if (!redis) return;
  try {
    await redis.set(key, body, 'EX', ttl);
  } catch (err) {
    recordServiceCacheError();
    logger.warn({ err, key }, 'Service cache write failed; keeping the in-process copy');
  }
}

/**
 * Return the cached service detail payload, building it with `load` on a miss.
 *
 * @param {number|string} id Service ID
 * @param {() => Promise<object|null>|object|null} load Builds a fresh payload.
 * @returns {Promise<{ body: string | null, etag: string | null, cached: boolean, notFound: boolean }>}
 */
export async function getCachedServiceDetail(id, load) {
  const key = getServiceCacheKey(id);
  const cached = await readCache(key);
  if (cached !== null) {
    recordServiceCacheLookup('hit');
    return {
      body: cached,
      etag: computeServiceEtag(cached),
      cached: true,
      notFound: false,
    };
  }

  recordServiceCacheLookup('miss');
  recordServiceCacheLoad();

  const data = await load();
  if (!data) {
    return {
      body: null,
      etag: null,
      cached: false,
      notFound: true,
    };
  }

  const body = JSON.stringify(data);
  await writeCache(key, body);

  return {
    body,
    etag: computeServiceEtag(body),
    cached: false,
    notFound: false,
  };
}

/** Cache configuration and counters, for the metrics endpoint. */
export function getServiceCacheStatus() {
  return {
    enabled: Boolean(redis),
    ttlSeconds: ttlSeconds(),
    keyPrefix: CACHE_KEY_PREFIX,
  };
}

/** Exposed for testing only — drops the in-process copy. */
export function _resetServiceMemoryCache() {
  memoryCache.clear();
}
