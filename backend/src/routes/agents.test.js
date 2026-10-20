import crypto from 'crypto';
import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getUpstreamTimeoutMetrics, resetRouteMetrics } from '../lib/routeMetrics.js';

const mockFlagAgentOnChain = vi.fn();
const mockAdminDeactivateAgentOnChain = vi.fn();
const mockGetAgent = vi.fn();
const mockGetAgentPolicy = vi.fn();
const mockGetAgentScore = vi.fn();
const mockGetAgentCount = vi.fn();
const mockIsAgentEligible = vi.fn();
const mockCheckSpendingAllowed = vi.fn();
const mockListAgentsPage = vi.fn();
const mockRegisterAgentOnChain = vi.fn();
const mockRecordPaymentOnChain = vi.fn();
const mockDeactivateAgentOnChain = vi.fn();
const mockUpdatePolicyOnChain = vi.fn();
const mockBuildUnsignedAgentTx = vi.fn();
const mockSubmitSignedAgentTx = vi.fn();

vi.mock('../lib/contract.js', () => ({
  flagAgentOnChain: (...args) => mockFlagAgentOnChain(...args),
  adminDeactivateAgentOnChain: (...args) => mockAdminDeactivateAgentOnChain(...args),
  getAgent: (...args) => mockGetAgent(...args),
  getAgentPolicy: (...args) => mockGetAgentPolicy(...args),
  getAgentScore: (...args) => mockGetAgentScore(...args),
  getAgentCount: (...args) => mockGetAgentCount(...args),
  isAgentEligible: (...args) => mockIsAgentEligible(...args),
  checkSpendingAllowed: (...args) => mockCheckSpendingAllowed(...args),
  listAgentsPage: (...args) => mockListAgentsPage(...args),
  registerAgentOnChain: (...args) => mockRegisterAgentOnChain(...args),
  recordPaymentOnChain: (...args) => mockRecordPaymentOnChain(...args),
  deactivateAgentOnChain: (...args) => mockDeactivateAgentOnChain(...args),
  updatePolicyOnChain: (...args) => mockUpdatePolicyOnChain(...args),
  buildUnsignedAgentTx: (...args) => mockBuildUnsignedAgentTx(...args),
  submitSignedAgentTx: (...args) => mockSubmitSignedAgentTx(...args),
}));

vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config.js', () => ({
  default: {
    contract: { agentsId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4' },
    server: { address: 'GADMINXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', secret: 'test_admin_secret_key' },
    rateLimit: { payment: { max: 10, windowMs: 60000 } },
    upstreamTimeout: { agentCheckMs: 8_000 },
  },
}));

vi.mock('../middleware/rateLimiter.js', () => ({
  writeRateLimiter: () => (_req, _res, next) => next(),
}));

vi.mock('../middleware/paymentRateLimiter.js', () => ({
  paymentRateLimiter: () => (_req, _res, next) => next(),
}));

function adminKey(body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto.createHmac('sha256', 'test_admin_secret_key').update(raw).digest('hex');
}

function makeApp() {
  const app = express();
  app.use(express.json());
  return app;
}

let app;

beforeAll(async () => {
  const router = (await import('./agents.js')).default;
  app = makeApp();
  app.use('/', router);
});

describe('POST /admin/agents/:address/flag', () => {
  const ADDRESS = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags an agent with valid admin key', async () => {
    mockFlagAgentOnChain.mockResolvedValueOnce(true);

    const body = { reason: 'violation of terms' };
    const res = await request(app)
      .post(`/admin/agents/${ADDRESS}/flag`)
      .set('X-Admin-Key', adminKey(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockFlagAgentOnChain).toHaveBeenCalledWith(ADDRESS, 'violation of terms');
  });

  it('returns 400 when reason is missing', async () => {
    const body = {};
    const res = await request(app)
      .post(`/admin/agents/${ADDRESS}/flag`)
      .set('X-Admin-Key', adminKey(body))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    expect(mockFlagAgentOnChain).not.toHaveBeenCalled();
  });

  it('returns 401 when X-Admin-Key is missing', async () => {
    const res = await request(app)
      .post(`/admin/agents/${ADDRESS}/flag`)
      .send({ reason: 'test' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ADMIN_KEY_MISSING');
    expect(mockFlagAgentOnChain).not.toHaveBeenCalled();
  });

 

  it('handles contract errors gracefully', async () => {
    mockFlagAgentOnChain.mockRejectedValueOnce(new Error('Chain error'));

    const body = { reason: 'test' };
    const res = await request(app)
      .post(`/admin/agents/${ADDRESS}/flag`)
      .set('X-Admin-Key', adminKey(body))
      .send(body);

    expect(res.status).toBe(500);
  });
});

describe('POST /admin/agents/:address/deactivate', () => {
  const ADDRESS = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deactivates an agent with valid admin key', async () => {
    mockAdminDeactivateAgentOnChain.mockResolvedValueOnce(true);

    const body = {};
    const res = await request(app)
      .post(`/admin/agents/${ADDRESS}/deactivate`)
      .set('X-Admin-Key', adminKey(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockAdminDeactivateAgentOnChain).toHaveBeenCalledWith(ADDRESS);
  });

  it('returns 401 when X-Admin-Key is missing', async () => {
    const res = await request(app)
      .post(`/admin/agents/${ADDRESS}/deactivate`)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ADMIN_KEY_MISSING');
    expect(mockAdminDeactivateAgentOnChain).not.toHaveBeenCalled();
  });

  it('returns 401 when X-Admin-Key is invalid', async () => {
    const res = await request(app)
      .post(`/admin/agents/${ADDRESS}/deactivate`)
      .set('X-Admin-Key', 'invalid')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ADMIN_KEY_INVALID');
    expect(mockAdminDeactivateAgentOnChain).not.toHaveBeenCalled();
  });

  it('handles contract errors gracefully', async () => {
    mockAdminDeactivateAgentOnChain.mockRejectedValueOnce(new Error('Chain error'));

    const body = {};
    const res = await request(app)
      .post(`/admin/agents/${ADDRESS}/deactivate`)
      .set('X-Admin-Key', adminKey(body))
      .send(body);

    expect(res.status).toBe(500);
  });
});

const mockGetActivityFeed = vi.fn(() => []);
const mockParseActivityPagination = vi.fn(() => ({ limit: 20, offset: 0, errors: [] }));

vi.mock('../lib/activityFeed.js', async () => {
  const actual = await vi.importActual('../lib/activityFeed.js');
  return {
    ...actual,
    getActivityFeed: (...args) => mockGetActivityFeed(...args),
    parseActivityPagination: (...args) => mockParseActivityPagination(...args),
  };
});

const VALID_ADDR = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';

describe('GET /api/agents/:address/score', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the score for a registered agent', async () => {
    mockGetAgentScore.mockResolvedValueOnce(742);

    const res = await request(app).get(`/agents/${VALID_ADDR}/score`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ score: 742 });
    expect(mockGetAgentScore).toHaveBeenCalledWith(VALID_ADDR);
  });

  it('returns 404 AGENT_NOT_FOUND instead of an in-band -1 sentinel', async () => {
    mockGetAgentScore.mockResolvedValueOnce(null);

    const res = await request(app).get(`/agents/${VALID_ADDR}/score`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Agent not found', code: 'AGENT_NOT_FOUND' });
  });

  it('surfaces a mapped contract error as its own HTTP status', async () => {
    const { ContractError } = await import('../lib/ContractError.js');
    mockGetAgentScore.mockRejectedValueOnce(
      new ContractError('Agent not found', 'AGENT_NOT_FOUND', 404)
    );

    const res = await request(app).get(`/agents/${VALID_ADDR}/score`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('AGENT_NOT_FOUND');
  });

  it('returns 500 for an unexpected read failure', async () => {
    mockGetAgentScore.mockRejectedValueOnce(new Error('RPC down'));

    const res = await request(app).get(`/agents/${VALID_ADDR}/score`);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('FETCH_ERROR');
  });
});

describe('GET /api/agents/:address/eligible', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a null score for an agent with no score instead of -1', async () => {
    mockGetAgentScore.mockResolvedValueOnce(null);
    mockIsAgentEligible.mockResolvedValueOnce(false);

    const res = await request(app).get(`/agents/${VALID_ADDR}/eligible?min_score=500`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eligible: false, score: null, required: 500 });
  });
});


describe('GET /api/agents/:address/payment-history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns paginated payment history for a given agent', async () => {
    mockGetActivityFeed.mockReturnValue([
      { agent: VALID_ADDR, txHash: 'abc123', service: 'Weather', amount: '0.001', timestamp: '2026-01-01T00:00:00Z' },
      { agent: VALID_ADDR, txHash: 'def456', service: 'Search', amount: '0.002', timestamp: '2026-01-01T01:00:00Z' },
      { agent: 'GOTHER', txHash: 'other1', service: 'Weather', amount: '0.001', timestamp: '2026-01-01T02:00:00Z' },
    ]);

    const res = await request(app).get(`/agents/${VALID_ADDR}/payment-history`);
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(2);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.pagination.hasMore).toBe(false);
  });

  it('returns empty payments when no activity matches the agent', async () => {
    mockGetActivityFeed.mockReturnValue([]);

    const res = await request(app).get(`/agents/${VALID_ADDR}/payment-history`);
    expect(res.status).toBe(200);
    expect(res.body.payments).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it('excludes entries without txHash', async () => {
    mockGetActivityFeed.mockReturnValue([
      { agent: VALID_ADDR, txHash: '', service: 'Weather', amount: '0.001' },
      { agent: VALID_ADDR, txHash: 'real123', service: 'Weather', amount: '0.001' },
      { agent: VALID_ADDR, service: 'NoHash', amount: '0.001' },
    ]);

    const res = await request(app).get(`/agents/${VALID_ADDR}/payment-history`);
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(1);
  });

  it('respects pagination params', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      agent: VALID_ADDR,
      txHash: `tx-${i}`,
      service: 'Weather',
      amount: '0.001',
    }));
    mockGetActivityFeed.mockReturnValue(entries);
    mockParseActivityPagination.mockReturnValueOnce({ limit: 10, offset: 5, errors: [] });

    const res = await request(app).get(`/agents/${VALID_ADDR}/payment-history?limit=10&offset=5`);
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(10);
    expect(res.body.pagination.total).toBe(25);
    expect(res.body.pagination.hasMore).toBe(true);
  });

  it('returns 400 when pagination params are invalid', async () => {
    mockParseActivityPagination.mockReturnValueOnce({ limit: 0, offset: 0, errors: ['`limit` must be a positive integer'] });
    mockGetActivityFeed.mockReturnValueOnce([]);

    const res = await request(app).get(`/agents/${VALID_ADDR}/payment-history?limit=-1`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAGINATION');
  });
});

// #635: the upstream Soroban call behind GET /agents/:address/check has to be
// bounded. A node that never answers must not hold the request open forever,
// and the caller has to be able to tell a timeout apart from a denial.
describe('GET /api/agents/:address/check', () => {
  const ADDRESS = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';
  const TIMEOUT_MS = 8_000;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckSpendingAllowed.mockReset();
    resetRouteMetrics();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the upstream decision when the call completes in time', async () => {
    mockCheckSpendingAllowed.mockResolvedValueOnce(true);

    const res = await request(app).get(`/agents/${ADDRESS}/check?amount=1000000`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      allowed: true,
      agentAddress: ADDRESS,
      amountStroops: '1000000',
    });
    expect(getUpstreamTimeoutMetrics().total).toBe(0);
  });

  it('returns 504 UPSTREAM_TIMEOUT when the call exceeds the deadline', async () => {
    vi.useFakeTimers();

    // Resolves once the route has reached the upstream call, which is the point
    // at which the deadline is armed. Awaiting it (rather than a timer) lets the
    // request reach the handler without needing the clock to move.
    let onCall;
    const called = new Promise((resolve) => {
      onCall = resolve;
    });
    mockCheckSpendingAllowed.mockImplementationOnce(() => {
      onCall();
      return new Promise(() => {});
    });

    const resPromise = request(app)
      .get(`/agents/${ADDRESS}/check?amount=1000000`)
      .then((r) => r);

    await called;
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    const res = await resPromise;

    expect(res.status).toBe(504);
    expect(res.body.code).toBe('UPSTREAM_TIMEOUT');
    expect(getUpstreamTimeoutMetrics().total).toBe(1);
    expect(getUpstreamTimeoutMetrics().byLabel['agent-check']).toBe(1);
  });
});
