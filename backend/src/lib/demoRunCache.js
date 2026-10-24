import { Redis } from 'ioredis';
import config from '../config.js';
import logger from './logger.js';

// The service record is stable across demo executions; caching only this read
// avoids repeated contract lookups without ever caching/skipping a paid run.
const redis = config.redisUrl
  ? new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false })
  : undefined;

let lookups = 0;
let hits = 0;
let misses = 0;
let errors = 0;

export async function getCachedService(serviceId, loadService) {
  lookups += 1;
  const key = `lodestar:demo-run:service:v1:${serviceId}`;
  if (!redis) {
    misses += 1;
    logLookup('disabled', serviceId);
    return loadService(serviceId);
  }

  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      hits += 1;
      logLookup('hit', serviceId);
      return JSON.parse(cached);
    }
  } catch (err) {
    errors += 1;
    misses += 1;
    logger.warn({ err, serviceId }, 'Demo service cache unavailable; loading from contract');
    return loadService(serviceId);
  }

  misses += 1;
  const service = await loadService(serviceId);
  if (service) {
    try {
      await redis.set(key, JSON.stringify(service), 'EX', config.demoRun.cacheTtlSeconds);
    } catch (err) {
      errors += 1;
      logger.warn({ err, serviceId }, 'Unable to populate demo service cache');
    }
  }
  logLookup('miss', serviceId);
  return service;
}

export function getDemoCacheMetrics() {
  return {
    lookups,
    hits,
    misses,
    errors,
    hitRate: lookups === 0 ? 0 : Number((hits / lookups).toFixed(4)),
    ttlSeconds: config.demoRun.cacheTtlSeconds,
    enabled: Boolean(redis),
  };
}

function logLookup(status, serviceId) {
  logger.info(
    { event: 'demo_service_cache', status, serviceId, ...getDemoCacheMetrics() },
    'Demo service cache lookup',
  );
}
