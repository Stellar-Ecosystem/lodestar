import { vi, describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockGetAgent = vi.fn();
const mockDeactivateAgentOnChain = vi.fn();

vi.mock('../lib/contract.js', () => ({
  listAgentsPage: vi.fn(),
  getAgent: (...args) => mockGetAgent(...args),
  getAgentPolicy: vi.fn(),
  getAgentScore: vi.fn(),
  getAgentCount: vi.fn(),
  registerAgentOnChain: vi.fn(),
  recordPaymentOnChain: vi.fn(),
  checkSpendingAllowed: vi.fn(),
  isAgentEligible: vi.fn(),
  flagAgentOnChain: vi.fn(),
  deactivateAgentOnChain: (...args) => mockDeactivateAgentOnChain(...args),
  adminDeactivateAgentOnChain: vi.fn(),
  updatePolicyOnChain: vi.fn(),
  buildUnsignedAgentTx: vi.fn(),
  submitSignedAgentTx: vi.fn(),
  isAgentRegistered: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Set a low deactivate ceiling (max: 2) so the limit fires quickly inside the test.
vi.mock('../config.js', () => ({
  default: {
    contract: { agentsId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4' },
    server: { address: 'GADMINXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', secret: 'test_admin_secret_key' },
    rateLimit: {
      windowMs: 60_000,
      max: 20,
      payment: { windowMs: 60_000, max: 10 },
      weather: { windowMs: 60_000, max: 30 },
      deactivate: { windowMs: 60_000, max: 2 },
    },
  },
}));

let app;

beforeAll(async () => {
  const router = (await import('./agents.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api', router);
});

describe('POST /api/agents/:address/deactivate rate limit (#647)', () => {
  const AGENT_ADDR = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';
  const OWNER_ADDR = 'GBWM5W4EBCAOVKAMBUDAMODYPOA7L6IJ33YQGLNQVQV6ETJ3JFYL6VLV';

  it('answers 429 with Retry-After once the deactivate ceiling is reached', async () => {
    mockGetAgent.mockResolvedValue({ address: AGENT_ADDR, owner: OWNER_ADDR, active: true });
    mockDeactivateAgentOnChain.mockResolvedValue(true);

    const sendDeactivate = () =>
      request(app)
        .post(`/api/agents/${AGENT_ADDR}/deactivate`)
        .set('x-caller-address', OWNER_ADDR)
        .set('x-caller-signature', 'mock-signature')
        .send({});

    const first = await sendDeactivate();
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ success: true });

    const second = await sendDeactivate();
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ success: true });

    const third = await sendDeactivate();
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('RATE_LIMITED');
    expect(third.headers['retry-after']).toBe('60');
    // The throttled request must be rejected before ownerAuth or contract RPC calls run.
    expect(mockGetAgent).toHaveBeenCalledTimes(2);
    expect(mockDeactivateAgentOnChain).toHaveBeenCalledTimes(2);
  });
});
