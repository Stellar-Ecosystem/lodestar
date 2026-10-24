import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import * as contract from '../src/lib/contract.js';

// Mock contract methods
vi.mock('../src/lib/contract.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAgent: vi.fn(),
    getAgentPolicy: vi.fn(),
    checkSpendingAllowed: vi.fn(),
  };
});

vi.mock('../src/middleware/rateLimiter.js', () => ({
  writeRateLimiter: () => (_req, _res, next) => next(),
  paymentRateLimiter: () => (_req, _res, next) => next(),
}));

vi.mock('../src/lib/logger.js', () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/config.js', () => ({
  default: {
    contract: { agentsId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4' },
    canSpend: { cacheTtlSeconds: 15 },
    canSpendCacheTtlSeconds: 15,
    server: { address: 'GADMINXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', secret: 'test_admin_secret_key' },
    rateLimit: { payment: { max: 10, windowMs: 60000 }, write: { max: 10, windowMs: 60000 } },
  },
}));

const VALID_ADDR = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';

describe('GET /api/agents/:address/can-spend and /metrics', () => {
  let app;
  let canSpendCacheModule;

  beforeEach(async () => {
    vi.clearAllMocks();

    canSpendCacheModule = await import('../src/lib/canSpendCache.js');
    canSpendCacheModule.resetCanSpendCacheMetrics();

    contract.getAgent.mockResolvedValue({
      address: VALID_ADDR,
      active: true,
      flagged: false,
    });
    contract.getAgentPolicy.mockResolvedValue({
      max_per_tx_stroops: '10000000',
      daily_spent_stroops: '0',
      max_per_day_stroops: '50000000',
      allowed_categories: ['weather'],
    });
    contract.checkSpendingAllowed.mockResolvedValue(true);

    const agentsRouter = (await import('../src/routes/agents.js')).default;
    app = express();
    app.use(express.json());
    app.use('/api', agentsRouter);
  });

  it('serves Cache-Control and ETag headers on successful response', async () => {
    const res = await request(app).get(`/api/agents/${VALID_ADDR}/can-spend?amount=0.001&category=weather`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true, reason: 'OK' });
    expect(res.headers['cache-control']).toBe('public, max-age=15, must-revalidate');
    expect(res.headers['etag']).toMatch(/^W\/"[a-f0-9]{64}"$/);
  });

  it('returns 304 Not Modified when If-None-Match matches ETag', async () => {
    const firstRes = await request(app).get(`/api/agents/${VALID_ADDR}/can-spend?amount=0.001&category=weather`);
    expect(firstRes.status).toBe(200);
    const etag = firstRes.headers['etag'];

    const condRes = await request(app)
      .get(`/api/agents/${VALID_ADDR}/can-spend?amount=0.001&category=weather`)
      .set('If-None-Match', etag);

    expect(condRes.status).toBe(304);
    expect(condRes.headers['etag']).toBe(etag);
    expect(condRes.headers['cache-control']).toBe('public, max-age=15, must-revalidate');
    expect(condRes.text).toBe('');
  });

  it('returns 200 when If-None-Match does not match', async () => {
    const res = await request(app)
      .get(`/api/agents/${VALID_ADDR}/can-spend?amount=0.001&category=weather`)
      .set('If-None-Match', 'W/"stale-etag"');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ allowed: true, reason: 'OK' });
  });

  it('exposes cache hit rate and metrics at GET /api/agents/can-spend/metrics', async () => {
    const res = await request(app).get('/api/agents/can-spend/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toHaveProperty('lookups');
    expect(res.body).toHaveProperty('hits');
    expect(res.body).toHaveProperty('misses');
    expect(res.body).toHaveProperty('errors');
    expect(res.body).toHaveProperty('hitRate');
    expect(res.body).toHaveProperty('ttlSeconds', 15);
    expect(typeof res.body.hitRate).toBe('number');
  });

  it('also exposes metrics at GET /api/agents/:address/can-spend/metrics', async () => {
    const res = await request(app).get(`/api/agents/${VALID_ADDR}/can-spend/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toHaveProperty('hitRate');
  });
});
