import crypto from 'crypto';
import config from '../config.js';
import logger from '../lib/logger.js';

export function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || typeof key !== 'string') {
    logger.warn({ path: req.path }, 'Missing X-Admin-Key header');
    return res.status(401).json({
      error: 'Missing X-Admin-Key header',
      code: 'ADMIN_KEY_MISSING',
    });
  }

  const body = JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', config.server.secret)
    .update(body)
    .digest('hex');

  const keyBuf = Buffer.from(key);
  const expBuf = Buffer.from(expected);

  if (keyBuf.length !== expBuf.length || !crypto.timingSafeEqual(keyBuf, expBuf)) {
    logger.warn({ path: req.path }, 'Invalid X-Admin-Key');
    return res.status(401).json({
      error: 'Invalid admin key',
      code: 'ADMIN_KEY_INVALID',
    });
  }

  next();
}
