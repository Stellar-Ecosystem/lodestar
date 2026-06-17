import { vi, describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockGetAgentScore = vi.fn();
const mockIsAgentEligible = vi.fn();
const mockGetAgent = vi.fn();
const mockGetAgentPolicy = vi.fn();

vi.mock('../lib/contract.js', () => ({
  getAgentScore: (...args) => mockGetAgentScore(...args),
  isAgentEligible: (...args) => mockIsAgentEligible(...args),
  getAgent: (...args) => mockGetAgent(...args),
  getAgentPolicy: (...args) => mockGetAgentPolicy(...args),
  listAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../config.js', () => ({
  default: {
    contract: {
      agentsId: 'C...123',
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

describe('GET /api/agents/:address/eligible', () => {
  const address = 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ';

  it('should return eligible true when score is sufficient', async () => {
    mockGetAgentScore.mockResolvedValueOnce(600);
    mockIsAgentEligible.mockResolvedValueOnce(true);

    const res = await request(app).get(`/api/agents/${address}/eligible?min_score=500`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      eligible: true,
      score: 600,
      required: 500,
    });
  });

  it('should return eligible false when score is insufficient', async () => {
    mockGetAgentScore.mockResolvedValueOnce(400);
    mockIsAgentEligible.mockResolvedValueOnce(false);

    const res = await request(app).get(`/api/agents/${address}/eligible?min_score=500`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      eligible: false,
      score: 400,
      required: 500,
    });
  });

  it('should return 500 when contract call fails', async () => {
    mockGetAgentScore.mockRejectedValueOnce(new Error('Chain error'));

    const res = await request(app).get(`/api/agents/${address}/eligible?min_score=500`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to check eligibility',
      code: 'FETCH_ERROR',
    });
  });
});
