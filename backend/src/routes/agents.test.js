import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';

process.env.CONTRACT_ID = 'TEST_CONTRACT_ID';
process.env.SERVER_STELLAR_ADDRESS = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
process.env.SERVER_STELLAR_SECRET = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
process.env.STELLAR_RPC_URL = 'http://localhost';
process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
process.env.FACILITATOR_URL = 'http://localhost';
process.env.USDC_CONTRACT_ID = 'USDC_TEST';

import express from 'express';
import request from 'supertest';

const mockGetAgent = vi.fn();
const mockGetAgentPolicy = vi.fn();
const mockGetAgentScore = vi.fn();
const mockIsAgentEligible = vi.fn();
const mockCheckSpendingAllowed = vi.fn();
const mockFlagAgentOnChain = vi.fn();
const mockDeactivateAgentOnChain = vi.fn();
const mockUpdatePolicyOnChain = vi.fn();
const mockRecordPaymentOnChain = vi.fn();

vi.mock('../lib/contract.js', () => ({
  listAgents: vi.fn(),
  getAgent: (...args) => mockGetAgent(...args),
  getAgentPolicy: (...args) => mockGetAgentPolicy(...args),
  getAgentScore: (...args) => mockGetAgentScore(...args),
  isAgentEligible: (...args) => mockIsAgentEligible(...args),
  checkSpendingAllowed: (...args) => mockCheckSpendingAllowed(...args),
  registerAgentOnChain: vi.fn(),
  recordPaymentOnChain: (...args) => mockRecordPaymentOnChain(...args),
  flagAgentOnChain: (...args) => mockFlagAgentOnChain(...args),
  deactivateAgentOnChain: (...args) => mockDeactivateAgentOnChain(...args),
  updatePolicyOnChain: (...args) => mockUpdatePolicyOnChain(...args),
  getAgentCount: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

let app;

beforeAll(async () => {
  const router = (await import('./agents.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api', router);
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Agent address param validation', () => {
  const invalidAddress = 'INVALID_ADDRESS';
  const invalidRoutes = [
    { method: 'get', path: `/api/agents/${invalidAddress}` },
    { method: 'get', path: `/api/agents/${invalidAddress}/policy` },
    { method: 'get', path: `/api/agents/${invalidAddress}/score` },
    { method: 'get', path: `/api/agents/${invalidAddress}/eligible` },
    { method: 'get', path: `/api/agents/${invalidAddress}/can-spend` },
    { method: 'get', path: `/api/agents/${invalidAddress}/check` },
    { method: 'post', path: `/api/agents/${invalidAddress}/payment`, body: { amountUsdc: '1.00', success: true } },
    { method: 'post', path: `/api/agents/${invalidAddress}/flag`, body: { reason: 'fraud' } },
    { method: 'post', path: `/api/agents/${invalidAddress}/deactivate` },
    { method: 'post', path: `/api/agents/${invalidAddress}/policy`, body: { maxPerTxStroops: 100, maxPerDayStroops: 1000, allowedCategories: [], minScoreToEarn: 0 } },
  ];

  it('returns 400 INVALID_ADDRESS for malformed agent address params', async () => {
    for (const route of invalidRoutes) {
      const req = request(app)[route.method](route.path);
      if (route.body) {
        req.send(route.body);
      }
      const res = await req;

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid Stellar address format', code: 'INVALID_ADDRESS' });
    }

    expect(mockGetAgent).not.toHaveBeenCalled();
    expect(mockGetAgentPolicy).not.toHaveBeenCalled();
    expect(mockGetAgentScore).not.toHaveBeenCalled();
    expect(mockIsAgentEligible).not.toHaveBeenCalled();
    expect(mockCheckSpendingAllowed).not.toHaveBeenCalled();
    expect(mockRecordPaymentOnChain).not.toHaveBeenCalled();
    expect(mockFlagAgentOnChain).not.toHaveBeenCalled();
    expect(mockDeactivateAgentOnChain).not.toHaveBeenCalled();
    expect(mockUpdatePolicyOnChain).not.toHaveBeenCalled();
  });
});
