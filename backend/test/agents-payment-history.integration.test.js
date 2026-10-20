import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { ContractError } from '../src/lib/ContractError.js';

const { mockConfig, mockGetActivityFeed } = vi.hoisted(() => ({
  mockConfig: {
    contract: {
      agentsId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    },
    rateLimit: {
      payment: { max: 10, windowMs: 60000 },
      write: { max: 10, windowMs: 60000 },
    },
    server: {
      secret: 'SDY6B5V7K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5',
    },
  },
  mockGetActivityFeed: vi.fn(() => []),
}));

// Mock contract layer to avoid hitting Stellar RPC
vi.mock('../src/lib/contract.js', () => ({
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
  submitSignedAgentTx: vi.fn(),
  isAgentRegistered: vi.fn(),
}));

// Mock logger to keep test output clean
vi.mock('../src/lib/logger.js', () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/config.js', () => ({
  default: mockConfig,
}));

// Rate limiters bypass for other routes mounted on the router
vi.mock('../src/middleware/rateLimiter.js', () => ({
  writeRateLimiter: () => (_req, _res, next) => next(),
}));

vi.mock('../src/middleware/paymentRateLimiter.js', () => ({
  paymentRateLimiter: () => (_req, _res, next) => next(),
}));

vi.mock('../src/lib/activityFeed.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getActivityFeed: (...args) => mockGetActivityFeed(...args),
  };
});

// NOTE: addressValidator middleware (validateAgentAddressParam) is intentionally
// NOT mocked so the integration test exercises real middleware ordering and validation.

import agentsRouter from '../src/routes/agents.js';

const app = express();
app.use(express.json());
// Mount router exactly as mounted in src/index.js
app.use('/api', agentsRouter);

const VALID_ADDRESS = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';
const OTHER_ADDRESS = 'GBOWOWNERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const INVALID_ADDRESS = 'invalid-not-a-stellar-public-key';

describe('GET /api/agents/:address/payment-history integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.contract.agentsId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
  });

  describe('Happy path', () => {
    it('asserts 200 status, JSON content type header, and full body shape with pagination', async () => {
      const mockEntries = [
        {
          agent: VALID_ADDRESS,
          txHash: '0x123abc456def',
          service: 'Weather Oracle',
          amount: '0.05',
          timestamp: '2026-03-30T12:00:00.000Z',
        },
        {
          agent: VALID_ADDRESS,
          txHash: '0x789ghi012jkl',
          service: 'Search Engine',
          amount: '0.10',
          timestamp: '2026-03-30T13:00:00.000Z',
        },
        // Entry for a different agent that should be filtered out
        {
          agent: OTHER_ADDRESS,
          txHash: '0xotheragenttx',
          service: 'Weather Oracle',
          amount: '0.01',
          timestamp: '2026-03-30T14:00:00.000Z',
        },
        // Entry missing txHash that should be filtered out
        {
          agent: VALID_ADDRESS,
          txHash: '',
          service: 'Pending Service',
          amount: '0.02',
          timestamp: '2026-03-30T15:00:00.000Z',
        },
      ];

      mockGetActivityFeed.mockReturnValue(mockEntries);

      const res = await request(app)
        .get(`/api/agents/${VALID_ADDRESS}/payment-history`)
        .expect('Content-Type', /application\/json/);

      expect(res.status).toBe(200);

      // Assert top-level response shape
      expect(res.body).toHaveProperty('payments');
      expect(res.body).toHaveProperty('pagination');

      // Assert payments structure and filtering
      expect(Array.isArray(res.body.payments)).toBe(true);
      expect(res.body.payments).toHaveLength(2);
      expect(res.body.payments).toEqual([
        {
          agent: VALID_ADDRESS,
          txHash: '0x123abc456def',
          service: 'Weather Oracle',
          amount: '0.05',
          timestamp: '2026-03-30T12:00:00.000Z',
        },
        {
          agent: VALID_ADDRESS,
          txHash: '0x789ghi012jkl',
          service: 'Search Engine',
          amount: '0.10',
          timestamp: '2026-03-30T13:00:00.000Z',
        },
      ]);

      // Assert pagination object shape
      expect(res.body.pagination).toEqual({
        total: 2,
        limit: 20,
        offset: 0,
        hasMore: false,
      });
    });

    it('handles custom pagination parameters and reports hasMore accurately', async () => {
      const mockEntries = [
        { agent: VALID_ADDRESS, txHash: 'tx-1', service: 'Svc1', amount: '0.01' },
        { agent: VALID_ADDRESS, txHash: 'tx-2', service: 'Svc2', amount: '0.02' },
        { agent: VALID_ADDRESS, txHash: 'tx-3', service: 'Svc3', amount: '0.03' },
      ];
      mockGetActivityFeed.mockReturnValue(mockEntries);

      const res = await request(app)
        .get(`/api/agents/${VALID_ADDRESS}/payment-history?limit=1&offset=1`)
        .expect('Content-Type', /application\/json/);

      expect(res.status).toBe(200);
      expect(res.body.payments).toHaveLength(1);
      expect(res.body.payments[0].txHash).toBe('tx-2');
      expect(res.body.pagination).toEqual({
        total: 3,
        limit: 1,
        offset: 1,
        hasMore: true,
      });
    });
  });

  describe('Failure modes and middleware ordering', () => {
    it('failure mode 1: returns 400 INVALID_ADDRESS when address parameter is invalid', async () => {
      const res = await request(app)
        .get(`/api/agents/${INVALID_ADDRESS}/payment-history`)
        .expect('Content-Type', /application\/json/);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Invalid Stellar address format',
        code: 'INVALID_ADDRESS',
      });
      // Ensure data layer was never accessed
      expect(mockGetActivityFeed).not.toHaveBeenCalled();
    });

    it('failure mode 2: returns 503 AGENTS_NOT_CONFIGURED when contract is unconfigured', async () => {
      mockConfig.contract.agentsId = '';

      const res = await request(app)
        .get(`/api/agents/${VALID_ADDRESS}/payment-history`)
        .expect('Content-Type', /application\/json/);

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: 'Agents contract not yet deployed. Set AGENTS_CONTRACT_ID in .env',
        code: 'AGENTS_NOT_CONFIGURED',
      });
      expect(mockGetActivityFeed).not.toHaveBeenCalled();
    });

    it('failure mode 3: returns 400 INVALID_PAGINATION on malformed pagination query params', async () => {
      const res = await request(app)
        .get(`/api/agents/${VALID_ADDRESS}/payment-history?limit=-1&offset=abc`)
        .expect('Content-Type', /application\/json/);

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
      expect(res.body.code).toBe('INVALID_PAGINATION');
      expect(mockGetActivityFeed).not.toHaveBeenCalled();
    });

    it('failure mode 4: handles contract / internal errors via handleContractError', async () => {
      // Test mapped ContractError
      mockGetActivityFeed.mockImplementationOnce(() => {
        throw new ContractError('Rate limit exceeded on RPC', 'RPC_THROTTLED');
      });

      const throttledRes = await request(app)
        .get(`/api/agents/${VALID_ADDRESS}/payment-history`)
        .expect('Content-Type', /application\/json/);

      expect(throttledRes.status).toBe(503);
      expect(throttledRes.body).toEqual({
        error: 'Rate limit exceeded on RPC',
        code: 'RPC_THROTTLED',
      });

      // Test unexpected runtime error
      mockGetActivityFeed.mockImplementationOnce(() => {
        throw new Error('Database read failure');
      });

      const errorRes = await request(app)
        .get(`/api/agents/${VALID_ADDRESS}/payment-history`)
        .expect('Content-Type', /application\/json/);

      expect(errorRes.status).toBe(500);
      expect(errorRes.body).toEqual({
        error: 'Failed to fetch payment history',
        code: 'FETCH_ERROR',
      });
    });

    it('verifies middleware ordering: validateAgentAddressParam runs before requireAgentsContract', async () => {
      // Even if contract is unconfigured (which would yield 503 if requireAgentsContract ran first),
      // an invalid address MUST yield 400 INVALID_ADDRESS first because address validation is mounted first.
      mockConfig.contract.agentsId = null;

      const res = await request(app)
        .get(`/api/agents/${INVALID_ADDRESS}/payment-history`)
        .expect('Content-Type', /application\/json/);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ADDRESS');
      expect(mockGetActivityFeed).not.toHaveBeenCalled();
    });
  });
});
