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
 */
export function createRateLimiter(
  max = config.rateLimit.max,
  windowMs = config.rateLimit.windowMs,
) {
  let store;
  if (client) {
    store = new RedisStore({
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
      // RFC 7231: Retry-After is in seconds. express-rate-limit's standard
      // headers do not include Retry-After, so set it explicitly so clients
      // (and proxies) can back off correctly.
      res.set('Retry-After', Math.ceil(windowMs / 1000));
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
 * Limiter for POST /agents/register.
 *
 * Ceiling rationale: every accepted call reaches the RPC provider (Lodestar
 * forwards to it), so an unthrottled route is an amplification vector — a
 * cheap HTTP request becomes an expensive RPC call and the provider throttles
 * Lodestar. Registration is a rare, one-per-agent action, so a tight ceiling
 * is appropriate: 10 requests per 10 minutes per IP. This is deliberately
 * stricter than the generic write limiter and is NOT a default — do not
 * "fix" it to match config.rateLimit without re-checking the RPC cost.
 */
export function agentRegisterRateLimiter() {
  return writeRateLimiter(10, 10 * 60 * 1000);
}

/**
 * The shared Redis client, or undefined when REDIS_URL is unset.
 * Exposed so the readiness probe can ping the same connection the rate limiter
 * actually uses, rather than opening a second one (#841).
 */
export function getRateLimiterRedis() {
  return client;
}