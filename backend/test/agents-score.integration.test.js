import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import agentsRouter from '../src/routes/agents.js';
import * as contract from '../src/lib/contract.js';
import { ContractError } from '../src/lib/ContractError.js';
import config from '../src/config.js';

// Mock contract layer only - preserving actual middleware ordering
vi.mock('../src/lib/contract.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAgentScore: vi.fn(),
  };
});

vi.mock('../src/lib/logger.js', () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Create Express app mounting agentsRouter on /api exactly as in src/index.js
const app = express();
app.use(express.json());
app.use('/api', agentsRouter);

const VALID_ADDRESS = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';
const INVALID_ADDRESS = 'NOT_A_VALID_STELLAR_ADDRESS';

describe('GET /api/agents/:address/score - Integration', () => {
  const originalAgentsId = config.contract.agentsId;

  beforeEach(() => {
    vi.clearAllMocks();
    config.contract.agentsId = originalAgentsId || 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
  });

  describe('Happy path', () => {
    it('returns 200 with score, application/json content-type and expected shape', async () => {
      contract.getAgentScore.mockResolvedValueOnce(850);

      const res = await request(app)
        .get(`/api/agents/${VALID_ADDRESS}/score`)
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ score: 850 });
      expect(contract.getAgentScore).toHaveBeenCalledWith(VALID_ADDRESS);
    });

    it('returns 200 with score 0 when agent has a zero score', async () => {
      contract.getAgentScore.mockResolvedValueOnce(0);

      const res = await request(app)
        .get(`/api/agents/${VALID_ADDRESS}/score`)
        .set('Accept', 'application/json');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ score: 0 });
      expect(contract.getAgentScore).toHaveBeenCalledWith(VALID_ADDRESS);
    });
  });

  describe('Middleware ordering & failure modes', () => {
    it('returns 400 INVALID_ADDRESS when address param is invalid (validateAgentAddressParam runs before contract)', async () => {
      const res = await request(app)
        .get(`/api/agents/${INVALID_ADDRESS}/score`)
        .set('Accept', 'application/json');

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({
        error: 'Invalid Stellar address format',
        code: 'INVALID_ADDRESS',
      });
      // Contract layer must not be called when address validation fails
      expect(contract.getAgentScore).not.toHaveBeenCalled();
    });

    it('returns 503 AGENTS_NOT_CONFIGURED when agentsId is missing (requireAgentsContract)', async () => {
      config.contract.agentsId = '';

      const res = await request(app)
        .get(`/api/agents/${VALID_ADDRESS}/score`)
        .set('Accept', 'application/json');

      expect(res.status).toBe(503);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({
        error: 'Agents contract not yet deployed. Set AGENTS_CONTRACT_ID in .env',
        code: 'AGENTS_NOT_CONFIGURED',
      });
      expect(contract.getAgentScore).not.toHaveBeenCalled();
    });

    it('returns 404 AGENT_NOT_FOUND when contract returns null', async () => {
      contract.getAgentScore.mockResolvedValueOnce(null);

      const res = await request(app)
        .get(`/api/agents/${VALID_ADDRESS}/score`)
        .set('Accept', 'application/json');

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({
        error: 'Agent not found',
        code: 'AGENT_NOT_FOUND',
      });
      expect(contract.getAgentScore).toHaveBeenCalledWith(VALID_ADDRESS);
    });

    it('surfaces mapped contract error from handleContractError', async () => {
      contract.getAgentScore.mockRejectedValueOnce(
        new ContractError('Agent record does not exist', 'AGENT_NOT_FOUND', 404)
      );

      const res = await request(app)
        .get(`/api/agents/${VALID_ADDRESS}/score`)
        .set('Accept', 'application/json');

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({
        error: 'Agent record does not exist',
        code: 'AGENT_NOT_FOUND',
      });
    });

    it('returns 500 FETCH_ERROR when contract layer throws an unhandled error', async () => {
      contract.getAgentScore.mockRejectedValueOnce(new Error('RPC network connection timeout'));

      const res = await request(app)
        .get(`/api/agents/${VALID_ADDRESS}/score`)
        .set('Accept', 'application/json');

      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({
        error: 'Failed to fetch score',
        code: 'FETCH_ERROR',
      });
    });
  });
});
