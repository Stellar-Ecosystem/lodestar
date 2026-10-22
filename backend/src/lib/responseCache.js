'use strict';

const crypto = require('crypto');

/**
 * Redis-backed response cache for selected routes.
 *
 * Provides:
 *   - short-TTL caching keyed on route + params
 *   - Cache-Control / ETag headers
 *   - conditional request handling (304)
 *   - cache hit/miss metrics
 *
 * Configuration (env vars):
 *   RESPONSE_CACHE_TTL      - TTL in seconds (default: 30)
 *   RESPONSE_CACHE_ENABLED   - 'true'/'false' to toggle (default: true)
 *   RESPONSE_CACHE_MAX_BYTES - max serialized entry size (default: 51200)
 */

const DEFAULT_TTL = 30;
const DEFAULT_MAX_BYTES = 51200;

function parseInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function readConfig() {
  return {
    ttlSeconds: parseInt(process.env.RESPONSE_CACHE_TTL, DEFAULT_TTL),
    enabled: process.env.RESPONSE_CACHE_ENABLED !== 'false',
    maxBytes: parseInt(process.env.RESPONSE_CACHE_MAX_BYTES, DEFAULT_MAX_BYTES),
  };
}

function getRedisClient() {
  // Lazy resolution to avoid circular requires and to allow tests to inject a mock.
  try {
    // eslint-disable-next-line global-require
    const mod = require('./redis');
    if (mod && typeof mod.getClient === 'function') {
      return mod.getClient();
    }
    if (mod && mod.client) {
      return mod.client;
    }
  } catch (_err) {
    // Redis is optional; fall back to no cache.
  }
  return null;
}

const metrics = {
  hits: 0,
  misses: 0,
  bypasses: 0,
  errors: 0,
  stores: 0,
};

function getMetrics() {
  const total = metrics.hits + metrics.misses;
  return {
    ...metrics,
    total,
    hitRate: total > 0 ? metrics.hits / total : 0,
  };
}

function resetMetrics() {
  metrics.hits = 0;
  metrics.misses = 0;
  metrics.bypasses = 0;
  metrics.errors = 0;
  metrics.stores = 0;
}

function buildCacheKey(route, params) {
  const normalized = {};
  const keys = Object.keys(params || {}).sort();
  for (const k of keys) {
    normalized[k] = params[k];
  }
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
  return `response-cache:${route}:${hash}`;
}

function computeEtag(bodyBuf) {
  const hash = crypto.createHash('sha256').update(bodyBuf).digest('hex').slice(0, 32);
  return `W"${hash}"`;
}

function etagMatches(request, etag) {
  const header = request.headers && request.headers['if-none-match'];
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .map((v) => v.trim())
    .some((v) => v === etag || v === `W/${etag.slice(2)}`);
}

async function readCache(client, key) {
  if (!client) return null;
  try {
    const raw = await client.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.body !== 'string') return null;
    return {
      body: Buffer.from(parsed.body, 'base64'),
      etag: parsed.etag,
      contentType: parsed.contentType,
    };
  } catch (_err) {
    metrics.errors += 1;
    return null;
  }
}

async function writeCache(client, key, entry, ttlSeconds, maxBytes) {
  if (!client) return;
  const payload = JSON.stringify({
    body: entry.body.toString('base64'),
    etag: entry.etag,
    contentType: entry.contentType,
  });
  if (Buffer.byteLength(payload) > maxBytes) return;
  try {
    await client.set(key, payload, 'EX', ttlSeconds);
    metrics.stores += 1;
  } catch (_err) {
    metrics.errors += 1;
  }
}

/**
 * Express middleware factory.
 *
 * Usage:
 *   router.post('/admin/agents/:address/deactivate', cachedResponse('deactivate'), handler);
 *
 * Options:
 *   - ttl: override TTL in seconds
 *   - keyParams: function (req) => object of params to include in the key
 *   - varyOn: array of request headers to include in the key
 */
function cachedResponse(route, options = {}) {
  const config = readConfig();
  const ttlSeconds = options.ttl || config.ttl;
  const keyParams =
    typeof options.keyParams === 'function'
      ? options.keyParams
      : (req) => ({ ...req.params });
  const varyOn = Array.isArray(options.varyOn) ? options.varyOn : [];

  return async function responseCacheMiddleware(req, res, next) {
    if (!config.enabled) {
      metrics.bypasses += 1;
      res.set('Cache-Control', 'no-store');
      return next();
    }

    const client = getRedisClient();
    const params = { ...keyParams(req) };
    for (const hdr of varyOn) {
      params[`%hr:${hdr.toLowerCase()}`] = req.headers[hdr.toLowerCase()] || '';
    }
    const key = buildCacheKey(route, params);

    const cached = await readCache(client, key);
    if (cached) {
      metrics.hits += 1;
      res.set('Cache-Control', `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds}`);
      res.set('ETag', cached.etag);
      if (cached.contentType) res.set('Content-Type', cached.contentType);
      if (etagMatches(req, cached.etag)) {
        res.status(304).end();
        return;
      }
      res.status(200).send(cached.body);
      return;
    }

    metrics.misses += 1;

    // Capture the response body to store in cache.
    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);
    const originalEnd = res.end.bind(res);
    let stored = false;

    const finalize = async (bodyBuf, contentType) => {
      if (stored) return;
      stored = true;
      if (res.statusCode !== 200) return;
      const etag = computeEtag(bodyBuf);
      res.set('Cache-Control', `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds}`);
      res.set('ETag', etag);
      await writeCache(client, key, { body: bodyBuf, etag, contentType }, ttlSeconds, config.maxBytes);
    };

    res.send = (body) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body === undefined ? '' : body));
      const ct = res.getHeader('Content-Type') || 'application/json; charset=utf-8';
      finalize(buf, ct).catch(() => {});
      return originalSend(body);
    };

    res.json = (obj) => {
      const buf = Buffer.from(JSON.stringify(obj));
      finalize(buf, 'application/json; charset=utf-8').catch(() => {});
      return originalJson(obj);
    };

    res.end = (chunk) => {
      if (chunk !== undefined) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        const ct = res.getHeader('Content-Type') || 'application/json; charset=utf-8';
        finalize(buf, ct).catch(() => {});
      }
      return originalEnd(chunk);
    };

    return next();
  };
}

module.exports = {
  cachedResponse,
  getMetrics,
  resetMetrics,
  buildCacheKey,
  computeEtag,
  etagMatches,
  readConfig,
};
