import rateLimit from 'express-rate-limit';
import config from '../config.js';
import logger from '../lib/logger.js';

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
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn(
        { ip: req.ip, path: req.originalUrl, max, windowMs },
        'Write rate limit exceeded',
      );
      res.status(429).json({
        error: 'Too many requests. Please slow down and try again later.',
        code: 'RATE_LIMITED',
        retryAfterMs: windowMs,
      });
    },
  });
}
