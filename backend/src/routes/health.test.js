import { vi, describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import router from './registry.js';
import { _reset as resetIdempotency } from '../lib/idempotency.js';

describe('GET /health - Caching and Idempotency (Issues #672, #673)', () => {
  let app;

  beforeEach(() => {
    resetIdempotency();
    app = express();
    app.use(express.json());
    app.use('/api', router);
  });

  it('sets Cache-Control and ETag headers on health check', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.headers['cache-control']).toBe('public, max-age=5, stale-while-revalidate=10');
    expect(res.headers['etag']).toBeDefined();
    expect(res.headers['etag']).toMatch(/^W\/"[a-f0-9]{64}"$/);
  });

  it('honors conditional requests with 304 when ETag matches If-None-Match', async () => {
    const firstRes = await request(app).get('/api/health');
    const etag = firstRes.headers['etag'];

    const secondRes = await request(app)
      .get('/api/health')
      .set('If-None-Match', etag);

    expect(secondRes.status).toBe(304);
  });

  it('supports Idempotency-Key header and replays cached response', async () => {
    const key = 'test-health-key-1';

    const firstRes = await request(app)
      .get('/api/health')
      .set('Idempotency-Key', key);

    expect(firstRes.status).toBe(200);
    const initialTimestamp = firstRes.body.timestamp;

    // Retry with same idempotency key
    const secondRes = await request(app)
      .get('/api/health')
      .set('Idempotency-Key', key);

    expect(secondRes.status).toBe(200);
    expect(secondRes.headers['idempotency-replayed']).toBe('true');
    expect(secondRes.body.timestamp).toBe(initialTimestamp);
  });

  it('rejects malformed Idempotency-Key with 400', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Idempotency-Key', 'invalid key with spaces');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });
});
