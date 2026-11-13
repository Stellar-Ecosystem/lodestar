// Integration test: POST /agents/:address/submit-signed-tx is rate limited.
//
// Unlike agents.test.js, this file does NOT mock middleware/rateLimiter.js, so
// the real express-rate-limit middleware (in-memory store, no REDIS_URL) is
// mounted exactly as the router mounts it in production.
import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockSubmitSignedAgentTx = vi.fn();

vi.mock('../lib/contract.js', () => ({
  listAgentsPage: vi.fn(),
  getAgent: vi.fn(),
  getAgentPolicy: vi.fn(),
  getAgentScore: vi.fn(),
  getAgentCount: vi.fn(),
  registerAgentOnChain: vi.fn(),
  recordPaymentOnChain: vi.fn(),
  checkSpendingAllowed: vi.fn(),
  isAgentEligible: vi.fn(),
  flagAgentOnChain: vi.fn(),
  deactivateAgentOnChain: vi.fn(),
  adminDeactivateAgentOnChain: vi.fn(),
  updatePolicyOnChain: vi.fn(),
  buildUnsignedAgentTx: vi.fn(),
  submitSignedAgentTx: (...args) => mockSubmitSignedAgentTx(...args),
  isAgentRegistered: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config.js', () => ({
  default: {
    contract: { agentsId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4' },
    server: { address: 'GADMINXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', secret: 'test_admin_secret_key' },
    // Shared write default is intentionally much higher than the route ceiling
    // so the test proves the route uses its own, explicit limit.
    rateLimit: { windowMs: 60_000, max: 1000, payment: { max: 10, windowMs: 60_000 } },
  },
}));

const ADDRESS = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';
const PATH = `/agents/${ADDRESS}/submit-signed-tx`;

let app;
let limit;

beforeAll(async () => {
  const mod = await import('./agents.js');
  limit = mod.SUBMIT_SIGNED_TX_RATE_LIMIT;
  app = express();
  app.use(express.json());
  app.use('/', mod.default);
});

describe('POST /agents/:address/submit-signed-tx rate limiting', () => {
  beforeEach(() => {
    mockSubmitSignedAgentTx.mockReset();
    mockSubmitSignedAgentTx.mockResolvedValue('abc123hash');
  });

  it('uses a deliberate ceiling below the shared write default', () => {
    expect(limit.max).toBe(5);
    expect(limit.windowMs).toBe(60_000);
  });

  it('returns 429 with Retry-After once the ceiling is exceeded and stops reaching RPC', async () => {
    for (let i = 0; i < limit.max; i++) {
      const res = await request(app).post(PATH).send({ signedXdr: 'AAAA' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, hash: 'abc123hash' });
    }
    expect(mockSubmitSignedAgentTx).toHaveBeenCalledTimes(limit.max);

    const limited = await request(app).post(PATH).send({ signedXdr: 'AAAA' });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(limit.windowMs / 1000);

    // The throttled request must not have been forwarded to RPC.
    expect(mockSubmitSignedAgentTx).toHaveBeenCalledTimes(limit.max);
  });
});
