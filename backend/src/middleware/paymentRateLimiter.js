import logger from '../lib/logger.js';

/**
 * In-memory rate limiter for the payment route.
 * Limits each agent address to `maxRequests` calls per `windowMs`.
 */
const buckets = new Map();

export function paymentRateLimiter(maxRequests = 10, windowMs = 60_000) {
  return (req, res, next) => {
    const address = req.params.address;
    const now = Date.now();

    if (!buckets.has(address)) {
      buckets.set(address, []);
    }

    const timestamps = buckets.get(address).filter((t) => now - t < windowMs);
    timestamps.push(now);
    buckets.set(address, timestamps);

    if (timestamps.length > maxRequests) {
      logger.warn({ address, count: timestamps.length }, 'Payment rate limit hit');
      return res.status(429).json({
        error: 'Too many payment requests. Max 10 per minute per agent.',
        code: 'RATE_LIMITED',
        retryAfterMs: windowMs,
      });
    }

    next();
  };
}
