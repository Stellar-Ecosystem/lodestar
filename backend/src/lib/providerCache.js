import { Redis } from 'ioredis';
import config from '../config.js';
import logger from './logger.js';

// Provider service listings change far less often than they are read;
// caching in Redis avoids repeated contract lookups and ledger queries.
let customRedis = null;
let defaultRedis = null;

function getRedis() {
  if (customRedis !== null) {
    return customRedis === false ? undefined : customRedis;
  }
  if (!config.redisUrl) return undefined;
  if (!defaultRedis) {
    defaultRedis = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  }
  return defaultRedis;
}

export function setProviderCacheRedis(client) {
  customRedis = client;
}

export function resetProviderCacheRedis() {
  customRedis = null;
  if (defaultRedis) {
    try {
      defaultRedis.disconnect();
    } catch {
      // ignore
    }
    defaultRedis = null;
  }
}

export const PROVIDER_CACHE_KEY_PREFIX = 'lodestar:registry:by-provider:v1:';

export function getProviderCacheKey(address) {
  return `${PROVIDER_CACHE_KEY_PREFIX}${address}`;
}

let lookups = 0;
let hits = 0;
let misses = 0;
let errors = 0;

export async function getCachedServicesByProvider(address, loadServices) {
  lookups += 1;
  const key = getProviderCacheKey(address);
  const redis = getRedis();

  if (!redis) {
    misses += 1;
    logLookup('disabled', address);
    return loadServices(address);
  }

  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      hits += 1;
      logLookup('hit', address);
      return JSON.parse(cached);
    }
  } catch (err) {
    errors += 1;
    misses += 1;
    logger.warn({ err, address }, 'Provider services cache unavailable; loading from contract');
    return loadServices(address);
  }

  misses += 1;
  const result = await loadServices(address);
  if (result) {
    try {
      const ttl = config.registryCache?.ttlSeconds ?? 30;
      await redis.set(key, JSON.stringify(result), 'EX', ttl);
    } catch (err) {
      errors += 1;
      logger.warn({ err, address }, 'Unable to populate provider services cache');
    }
  }
  logLookup('miss', address);
  return result;
}

export async function invalidateProviderCache(address) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(getProviderCacheKey(address));
  } catch (err) {
    logger.warn({ err, address }, 'Failed to invalidate provider services cache');
  }
}

export function getProviderCacheMetrics() {
  const redis = getRedis();
  return {
    lookups,
    hits,
    misses,
    errors,
    hitRate: lookups === 0 ? 0 : Number((hits / lookups).toFixed(4)),
    ttlSeconds: config.registryCache?.ttlSeconds ?? 30,
    enabled: Boolean(redis),
  };
}

export function resetProviderCacheMetrics() {
  lookups = 0;
  hits = 0;
  misses = 0;
  errors = 0;
}

function logLookup(status, address) {
  logger.info(
    { event: 'provider_services_cache', status, address, ...getProviderCacheMetrics() },
    'Provider services cache lookup',
  );
}

// Aliases for registry cache naming
export const getRegistryCacheMetrics = getProviderCacheMetrics;
export const resetRegistryCacheMetrics = resetProviderCacheMetrics;
