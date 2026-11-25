/**
 * Short-TTL cache for the health payload (#672).
 *
 * `GET /api/health` is read far more often than the data it returns changes
 * (network, contract id, uptime). The payload is therefore cached for a few
 * seconds — in Redis when `REDIS_URL` is set so every replica shares one
 * copy, in-process otherwise — and served with `Cache-Control` + `ETag` so
 * browsers and CDNs can revalidate cheaply instead of refetching.
 *
 * The cache is best-effort by design: if Redis is unavailable the route falls
 * back to the in-process copy rather than failing.
 */

import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import config from '../config.js';
import logger from './logger.js';
import {
  recordHealthCacheError,
  recordHealthCacheLoad,
  recordHealthCacheLookup,
} from './routeMetrics.js';

/** Cache key — namespaced and versioned so a payload change cannot collide. */
const CACHE_KEY = 'lodestar:health:v1';

/** @type {Map<string, { value: string, expiresAt: number }>} */
const memoryCache = new Map();

/**
 * @type {import('ioredis').Redis | undefined}
 *
 * `enableOfflineQueue: false` + `retryStrategy: () => null` make an
 * unreachable Redis fail fast instead of parking the request in a queue while
 * the client reconnects — a health endpoint must not block on a dependency.
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
    logger.warn({ err }, 'Health cache Redis client error');
  });
}

/**
 * Weak ETag over the exact bytes that are sent to the client, so a
 * conditional request can be answered with 304 without re-serialising.
 *
 * @param {string} body
 * @returns {string}
 */
export function computeHealthEtag(body) {
  return `W/"${createHash('sha256').update(body).digest('hex')}"`;
}

function ttlSeconds() {
  return config.health.cacheTtlSeconds;
}

async function readCache(key) {
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw !== null) return raw;
    } catch (err) {
      recordHealthCacheError();
      logger.warn({ err }, 'Health cache read failed; using the in-process copy');
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
  memoryCache.set(key, { value: body, expiresAt: Date.now() + ttlSeconds() * 1000 });

  if (!redis) return;
  try {
    await redis.set(key, body, 'EX', ttlSeconds());
  } catch (err) {
    recordHealthCacheError();
    logger.warn({ err }, 'Health cache write failed; keeping the in-process copy');
  }
}

/**
 * Return the cached health payload, building it with `load` on a miss.
 *
 * @param {() => Promise<object>|object} load Builds a fresh payload.
 * @returns {Promise<{ body: string, etag: string, cached: boolean }>}
 */
export async function getCachedHealth(load) {
  const cached = await readCache(CACHE_KEY);
  if (cached !== null) {
    recordHealthCacheLookup('hit');
    return { body: cached, etag: computeHealthEtag(cached), cached: true };
  }

  recordHealthCacheLookup('miss');
  recordHealthCacheLoad();

  const body = JSON.stringify(await load());
  await writeCache(CACHE_KEY, body);

  return { body, etag: computeHealthEtag(body), cached: false };
}

/** Cache configuration and counters, for the metrics endpoint. */
export function getHealthCacheStatus() {
  return {
    enabled: Boolean(redis),
    ttlSeconds: ttlSeconds(),
    key: CACHE_KEY,
  };
}

/** Exposed for testing only — drops the in-process copy. */
export function _resetMemoryCache() {
  memoryCache.clear();
}
