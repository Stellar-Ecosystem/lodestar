import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { Redis } from 'ioredis';
import config from '../config.js';
import logger from '../lib/logger.js';

let client;
if (config.redisUrl) {
  client = new Redis(config.redisUrl);
}

/**
 * express-rate-limit middleware for public routes.
 *
 * Throttles spammy requests before they reach an upstream dependency. Keyed by
 * client IP. Limits default to the values in config.rateLimit but can be
 * overridden per-route (e.g. for tests or costlier endpoints).
 *
 * @param {number} [max]      Max requests allowed per window.
 * @param {number} [windowMs] Window length in milliseconds.
 * @param {string} [prefix]   Redis key prefix. Give each route its own so counters
 *                            are not shared across routes; keep it stable across instances.
 */
export function createRateLimiter(
  max = config.rateLimit.max,
  windowMs = config.rateLimit.windowMs,
  prefix,
) {
  let store;
  if (client) {
    store = new RedisStore({
      ...(prefix ? { prefix } : {}),
      sendCommand: (command, ...args) => client.call(command, ...args),
    });
  }
  return rateLimit({
    windowMs,
    limit: max,
    store,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn(
        { ip: req.ip, path: req.originalUrl, max, windowMs },
        'Rate limit exceeded',
      );
      // Retry-After tells the client when it may come back — the standard
      // signal for "slow down", which a JSON body alone does not express.
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      res.status(429).json({
        error: 'Too many requests. Please slow down and try again later.',
        code: 'RATE_LIMITED',
        retryAfterMs: windowMs,
      });
    },
  });
}

/**
 * Limiter for public write routes — the default ceiling from config.rateLimit.
 * Kept as a named export because write routes are the ones that cost money.
 */
export const writeRateLimiter = createRateLimiter;

/**
 * The shared Redis client, or undefined when REDIS_URL is unset.
 * Exposed so the readiness probe can ping the same connection the rate limiter
 * actually uses, rather than opening a second one (#841).
 */
export function getRateLimiterRedis() {
  return client;
}

export const rateLimiter = writeRateLimiter;
