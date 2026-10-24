import { Redis } from 'ioredis';
import config from '../config.js';
import logger from './logger.js';

const redis = config.redisUrl
  ? new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false })
  : undefined;

let lookups = 0;
let hits = 0;
let misses = 0;
let errors = 0;

export function buildCanSpendCacheKey(address, amount = '0', category = '') {
  return `lodestar:can-spend:v1:${address}:${amount}:${category}`;
}

export async function getCachedCanSpend(address, amount, category, computeCanSpend) {
  lookups += 1;
  const key = buildCanSpendCacheKey(address, amount, category);
  if (!redis) {
    misses += 1;
    logLookup('disabled', address, amount, category);
    return computeCanSpend();
  }

  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      hits += 1;
      logLookup('hit', address, amount, category);
      return JSON.parse(cached);
    }
  } catch (err) {
    errors += 1;
    misses += 1;
    logger.warn({ err, address, amount, category }, 'Can-spend cache unavailable; computing result');
    return computeCanSpend();
  }

  misses += 1;
  const result = await computeCanSpend();
  if (result) {
    try {
      const ttl = config.canSpend?.cacheTtlSeconds ?? config.canSpendCacheTtlSeconds ?? 15;
      await redis.set(key, JSON.stringify(result), 'EX', ttl);
    } catch (err) {
      errors += 1;
      logger.warn({ err, address, amount, category }, 'Unable to populate can-spend cache');
    }
  }
  logLookup('miss', address, amount, category);
  return result;
}

export function getCanSpendCacheMetrics() {
  const ttl = config.canSpend?.cacheTtlSeconds ?? config.canSpendCacheTtlSeconds ?? 15;
  return {
    lookups,
    hits,
    misses,
    errors,
    hitRate: lookups === 0 ? 0 : Number((hits / lookups).toFixed(4)),
    ttlSeconds: ttl,
    enabled: Boolean(redis),
  };
}

export function resetCanSpendCacheMetrics() {
  lookups = 0;
  hits = 0;
  misses = 0;
  errors = 0;
}

export async function invalidateCanSpendCache(address) {
  if (!redis) return;
  try {
    const keys = await redis.keys(`lodestar:can-spend:v1:${address}:*`);
    if (keys && keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (err) {
    logger.warn({ err, address }, 'Unable to invalidate can-spend cache');
  }
}

function logLookup(status, address, amount, category) {
  logger.info(
    { event: 'can_spend_cache', status, address, amount, category, ...getCanSpendCacheMetrics() },
    'Can-spend cache lookup',
  );
}
