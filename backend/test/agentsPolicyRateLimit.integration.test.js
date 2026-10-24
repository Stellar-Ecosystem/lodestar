import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import agentsRouter from '../src/routes/agents.js';
import * as contract from '../src/lib/contract.js';

// Mock contract dependency so no real network RPC is made
vi.mock('../src/lib/contract.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAgentPolicy: vi.fn(),
  };
});

vi.mock('../src/config.js', () => ({
  default: {
    contract: { agentsId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4' },
    rateLimit: {
      windowMs: 60_000,
      max: 20,
      payment: { max: 10, windowMs: 60_000 },
    },
    server: {
      secret: 'SDY6B5V7K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5',
    },
  },
}));

vi.mock('../src/lib/logger.js', () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const VALID_ADDR = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';

const app = express();
app.use(express.json());
app.use('/api', agentsRouter);

describe('GET /api/agents/:address/policy rate limiting integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows requests up to the deliberate ceiling and returns 429 with Retry-After on overage', async () => {
    contract.getAgentPolicy.mockResolvedValue({
      spendingLimit: 1000,
      period: 3600,
    });

    // Deliberate ceiling: 60 requests per 60,000 ms window
    const ceiling = 60;

    for (let i = 0; i < ceiling; i++) {
      const res = await request(app).get(`/api/agents/${VALID_ADDR}/policy`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        spendingLimit: 1000,
        period: 3600,
      });
    }

    // Verify all allowed requests reached RPC
    expect(contract.getAgentPolicy).toHaveBeenCalledTimes(ceiling);

    // Request 61 exceeds the ceiling and must be rate-limited
    const throttledRes = await request(app).get(`/api/agents/${VALID_ADDR}/policy`);

    expect(throttledRes.status).toBe(429);
    expect(throttledRes.body).toEqual({
      error: 'Too many requests. Please slow down and try again later.',
      code: 'RATE_LIMITED',
      retryAfterMs: 60_000,
    });

    // Acceptance criteria: 429 responses carry Retry-After header
    expect(throttledRes.headers['retry-after']).toBeDefined();
    expect(Number(throttledRes.headers['retry-after'])).toBeGreaterThan(0);

    // RPC was NOT called on the throttled request, shielding upstream provider
    expect(contract.getAgentPolicy).toHaveBeenCalledTimes(ceiling);
  });
});
