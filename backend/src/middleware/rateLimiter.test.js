import { vi, describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../config.js', () => ({
  default: {
    rateLimit: {
      windowMs: 60_000,
      max: 20,
      payment: { windowMs: 60_000, max: 10 },
    },
  },
}));

vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { writeRateLimiter } from './rateLimiter.js';

function makeApp(max, windowMs) {
  const app = express();
  app.use(express.json());
  app.post('/write', writeRateLimiter(max, windowMs), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('writeRateLimiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows requests up to the configured limit', async () => {
    const app = makeApp(3, 60_000);

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/write').send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }
  });

  it('returns 429 with RATE_LIMITED once the limit is exceeded', async () => {
    const app = makeApp(2, 60_000);

    await request(app).post('/write').send({});
    await request(app).post('/write').send({});

    const res = await request(app).post('/write').send({});
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.body.retryAfterMs).toBe(60_000);
  });

  it('uses config defaults when no arguments are supplied', async () => {
    const app = express();
    app.post('/write', writeRateLimiter(), (_req, res) => res.json({ ok: true }));

    // config.rateLimit.max is 20 in the mock; the 21st request should be limited.
    let lastStatus;
    for (let i = 0; i < 21; i++) {
      lastStatus = (await request(app).post('/write').send({})).status;
    }
    expect(lastStatus).toBe(429);
  });
});
