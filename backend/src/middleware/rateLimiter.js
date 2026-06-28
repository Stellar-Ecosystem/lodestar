import rateLimit from 'express-rate-limit';
import config from '../config.js';
import logger from '../lib/logger.js';

/**
 * Build a rate-limiter middleware factory with a shared error-response shape.
 */
function createLimiter(label, max, windowMs) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn(
        { ip: req.ip, path: req.originalUrl, max, windowMs },
        `${label} rate limit exceeded`,
      );
      res.status(429).json({
        error: 'Too many requests. Please slow down and try again later.',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterMs: windowMs,
      });
    },
  });
}

/**
 * Global per-IP rate limiter applied to all routes.
 * Default: 1000 req / 15 min per IP.
 */
export function globalRateLimiter() {
  return createLimiter('Global', config.rateLimit.global.max, config.rateLimit.global.windowMs);
}

/**
 * express-rate-limit middleware for public write routes.
 *
 * Throttles spammy submissions before they reach the on-chain contracts.
 * Keyed by client IP. Limits default to the values in config.rateLimit but
 * can be overridden per-route (e.g. for tests or stricter endpoints).
 *
 * @param {number} [max]      Max requests allowed per window.
 * @param {number} [windowMs] Window length in milliseconds.
 */
export function writeRateLimiter(
  max = config.rateLimit.max,
  windowMs = config.rateLimit.windowMs,
) {
  return createLimiter('Write', max, windowMs);
}

/**
 * Per-IP rate limiter for simulation-heavy read routes (GET /api/services, GET /api/agents).
 * Default: 60 req / min per IP.
 */
export function readRateLimiter() {
  return createLimiter('Read', config.rateLimit.read.max, config.rateLimit.read.windowMs);
}
