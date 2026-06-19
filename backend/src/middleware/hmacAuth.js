import crypto from 'crypto';
import config from '../config.js';
import logger from '../lib/logger.js';

/**
 * HMAC-SHA256 request signing middleware.
 * Requires X-Lodestar-Signature header matching HMAC-SHA256(body, secret).
 */
export function hmacAuth(req, res, next) {
  const signature = req.headers['x-lodestar-signature'];
  if (!signature || typeof signature !== 'string') {
    logger.warn({ path: req.path }, 'Missing X-Lodestar-Signature header');
    return res.status(401).json({
      error: 'Missing X-Lodestar-Signature header',
      code: 'HMAC_MISSING',
    });
  }

  const body = JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', config.server.secret)
    .update(body)
    .digest('hex');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    logger.warn({ path: req.path }, 'Invalid X-Lodestar-Signature');
    return res.status(401).json({
      error: 'Invalid signature',
      code: 'HMAC_INVALID',
    });
  }

  next();
}
