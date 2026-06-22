import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

const mockListAgents = vi.fn();
const mockGetAgent = vi.fn();
const mockGetAgentPolicy = vi.fn();
const mockGetAgentScore = vi.fn();
const mockGetAgentCount = vi.fn();
const mockIsAgentEligible = vi.fn();
const mockCheckSpendingAllowed = vi.fn();
const mockRecordPaymentOnChain = vi.fn();
const mockGetActivityFeed = vi.fn();

vi.mock('../lib/activityFeed.js', () => ({
  getActivityFeed: (...args) => mockGetActivityFeed(...args),
  parseActivityPagination: (query = {}) => {
    const limit = Math.min(Number(query.limit ?? 20), 50);
    const offset = Number(query.offset ?? 0);
    return { limit, offset, errors: [] };
  },
}));

vi.mock('../lib/contract.js', () => ({
  listAgents: (...args) => mockListAgents(...args),
  getAgent: (...args) => mockGetAgent(...args),
  getAgentPolicy: (...args) => mockGetAgentPolicy(...args),
  getAgentScore: (...args) => mockGetAgentScore(...args),
  getAgentCount: (...args) => mockGetAgentCount(...args),
  isAgentEligible: (...args) => mockIsAgentEligible(...args),
  checkSpendingAllowed: (...args) => mockCheckSpendingAllowed(...args),
  registerAgentOnChain: vi.fn(),
  recordPaymentOnChain: (...args) => mockRecordPaymentOnChain(...args),
  flagAgentOnChain: vi.fn(),
  deactivateAgentOnChain: vi.fn(),
  updatePolicyOnChain: vi.fn(),
}));

vi.mock('../config.js', () => ({
  default: {
    contract: { agentsId: 'mock_agents_id' },
    server: { address: 'mock', secret: 'hmac_test_secret' },
    stellar: { network: 'testnet', rpcUrl: 'https://mock', networkPassphrase: 'mock', usdcContractId: 'mock' },
    x402: { facilitatorUrl: 'https://mock', searchPrice: '0.001', weatherPrice: '0.001' },
    braveApiKey: '',
    corsOrigin: ['http://localhost:3000'],
    jsonBodyLimit: '100kb',
    rateLimit: {
      windowMs: 60_000,
      max: 20,
      payment: { windowMs: 60_000, max: 10 },
    },
    nodeEnv: 'test',
    port: 3001,
    logLevel: 'silent',
  },
}));

// The generic write rate limiter is exercised in isolation in
// middleware/rateLimiter.test.js; here it's a pass-through so route logic and
// the per-agent payment limiter can be tested without IP-based throttling.
vi.mock('../middleware/rateLimiter.js', () => ({
  writeRateLimiter: () => (_req, _res, next) => next(),
}));

vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../middleware/ownerAuth.js', () => ({
  ownerAuth: (req, _res, next) => { req.callerAddress = 'GA MOCK'; next(); },
}));

vi.mock('../middleware/addressValidator.js', () => ({
  validateAgentAddressParam: (req, _res, next) => {
    if (req.params.address && req.params.address.startsWith('G')) {
      next();
    } else {
      _res.status(400).json({ error: 'Invalid address', code: 'INVALID_ADDRESS' });
    }
  },
  isValidStellarAddress: () => true,
}));

// Reset idempotency store between tests so keys don't bleed across cases
import { _reset as resetIdempotencyStore } from '../lib/idempotency.js';

function signBody(body) {
  return crypto
    .createHmac('sha256', 'hmac_test_secret')
    .update(JSON.stringify(body))
    .digest('hex');
}

let app;

beforeAll(async () => {
  const router = (await import('./agents.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api', router);
});

beforeEach(() => {
  vi.clearAllMocks();
  resetIdempotencyStore();
});

function makeAgent(overrides = {}) {
  return {
    address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
    name: 'Test Agent',
    description: 'A test agent for testing',
    owner: 'GBV4ZDEPLQTVPQFJRME2BGYL6VQJLTTRIWJHTJNFGXBVF4WY5DJIQK2K',
    score: 100,
    total_payments: 5,
    successful_payments: 3,
    failed_payments: 2,
    total_volume_stroops: '10000000',
    registered_at: 1000,
    last_active: 2000,
    active: true,
    flagged: false,
    flag_reason: '',
    ...overrides,
  };
}

describe('GET /api/agents', () => {
  it('should return list of agents', async () => {
    const agents = [makeAgent({ address: 'GA1' }), makeAgent({ address: 'GA2' })];
    mockListAgents.mockResolvedValueOnce(agents);

    const res = await request(app).get('/api/agents');

    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(2);
    expect(res.body.count).toBe(2);
  });

  it('should return 500 when contract call fails', async () => {
    mockListAgents.mockRejectedValueOnce(new Error('Chain error'));

    const res = await request(app).get('/api/agents');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch agents', code: 'FETCH_ERROR' });
  });
});

describe('GET /api/agents/count', () => {
  it('should return agent count', async () => {
    mockGetAgentCount.mockResolvedValueOnce(5);

    const res = await request(app).get('/api/agents/count');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(5);
  });
});

describe('GET /api/agents/stats', () => {
  it('should return stats for agents', async () => {
    const agents = [
      makeAgent({ score: 100, total_volume_stroops: '10000000' }),
      makeAgent({ score: 200, total_volume_stroops: '20000000' }),
    ];
    mockListAgents.mockResolvedValueOnce(agents);

    const res = await request(app).get('/api/agents/stats');

    expect(res.status).toBe(200);
    expect(res.body.totalAgents).toBe(2);
    expect(res.body.avgScore).toBe(150);
  });

  it('should return zero stats when no agents', async () => {
    mockListAgents.mockResolvedValueOnce([]);

    const res = await request(app).get('/api/agents/stats');

    expect(res.status).toBe(200);
    expect(res.body.totalAgents).toBe(0);
    expect(res.body.avgScore).toBe(0);
  });
});

describe('GET /api/agents/:address', () => {
  it('should return agent with policy', async () => {
    const agent = makeAgent();
    mockGetAgent.mockResolvedValueOnce(agent);
    mockGetAgentPolicy.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/agents/GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ');

    expect(res.status).toBe(200);
    expect(res.body.agent.name).toBe('Test Agent');
  });

  it('should return 404 if agent not found', async () => {
    mockGetAgent.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/agents/GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Agent not found');
  });
});

describe('GET /api/agents/:address/score', () => {
  it('should return agent score', async () => {
    mockGetAgentScore.mockResolvedValueOnce(85);

    const res = await request(app).get('/api/agents/GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ/score');

    expect(res.status).toBe(200);
    expect(res.body.score).toBe(85);
  });
});

describe('POST /api/agents/:address/payment (HMAC + rate limit + idempotency)', () => {
  const agentAddress = 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ';
  const validBody = { amountUsdc: '0.001', success: true, serviceId: 1 };
  const idempotencyKey = 'test-idem-key-001';

  function makeRequest(body = validBody, key = idempotencyKey) {
    const signature = signBody(body);
    return request(app)
      .post(`/api/agents/${agentAddress}/payment`)
      .set('X-Lodestar-Signature', signature)
      .set('X-Idempotency-Key', key)
      .send(body);
  }

  it('should return 401 when X-Lodestar-Signature is missing', async () => {
    const res = await request(app)
      .post(`/api/agents/${agentAddress}/payment`)
      .set('X-Idempotency-Key', idempotencyKey)
      .send(validBody);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('HMAC_MISSING');
    expect(mockRecordPaymentOnChain).not.toHaveBeenCalled();
  });

  it('should return 401 when X-Lodestar-Signature is invalid', async () => {
    const res = await request(app)
      .post(`/api/agents/${agentAddress}/payment`)
      .set('X-Lodestar-Signature', 'wrong_signature')
      .set('X-Idempotency-Key', idempotencyKey)
      .send(validBody);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('HMAC_INVALID');
    expect(mockRecordPaymentOnChain).not.toHaveBeenCalled();
  });

  it('should return 400 when X-Idempotency-Key header is missing', async () => {
    const signature = signBody(validBody);
    const res = await request(app)
      .post(`/api/agents/${agentAddress}/payment`)
      .set('X-Lodestar-Signature', signature)
      .send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_MISSING');
    expect(mockRecordPaymentOnChain).not.toHaveBeenCalled();
  });

  it('should return 400 when X-Idempotency-Key is empty', async () => {
    const signature = signBody(validBody);
    const res = await request(app)
      .post(`/api/agents/${agentAddress}/payment`)
      .set('X-Lodestar-Signature', signature)
      .set('X-Idempotency-Key', '')
      .send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_MISSING');
    expect(mockRecordPaymentOnChain).not.toHaveBeenCalled();
  });

  it('should return 400 when serviceId is missing', async () => {
    const body = { amountUsdc: '0.001', success: true };
    const signature = signBody(body);
    const res = await request(app)
      .post(`/api/agents/${agentAddress}/payment`)
      .set('X-Lodestar-Signature', signature)
      .set('X-Idempotency-Key', idempotencyKey)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('should succeed with valid HMAC signature and idempotency key', async () => {
    mockRecordPaymentOnChain.mockResolvedValueOnce(true);
    mockGetAgent.mockResolvedValueOnce({ score: 110 });

    const res = await makeRequest();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.newScore).toBe(110);
    expect(res.body.idempotent).toBeUndefined();
    expect(mockRecordPaymentOnChain).toHaveBeenCalledOnce();
    expect(mockRecordPaymentOnChain).toHaveBeenCalledWith(
      agentAddress, 1, expect.any(BigInt), true
    );
  });

  it('should replay the cached response on a duplicate request (no second chain call)', async () => {
    mockRecordPaymentOnChain.mockResolvedValueOnce(true);
    mockGetAgent.mockResolvedValueOnce({ score: 110 });

    // First request
    const first = await makeRequest();
    expect(first.status).toBe(200);
    expect(first.body.newScore).toBe(110);

    // Retry with the exact same idempotency key — chain must NOT be called again
    const retry = await makeRequest();
    expect(retry.status).toBe(200);
    expect(retry.body.success).toBe(true);
    expect(retry.body.newScore).toBe(110);
    expect(retry.body.idempotent).toBe(true);
    expect(mockRecordPaymentOnChain).toHaveBeenCalledOnce(); // still only once
  });

  it('should allow a different key for a logically separate payment', async () => {
    mockRecordPaymentOnChain.mockResolvedValue(true);
    mockGetAgent.mockResolvedValue({ score: 120 });

    const res1 = await makeRequest(validBody, 'key-payment-A');
    const res2 = await makeRequest(validBody, 'key-payment-B');

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(mockRecordPaymentOnChain).toHaveBeenCalledTimes(2);
  });

  it('should scope keys per agent — same key for different agents does not collide', async () => {
    const agentB = 'GBXDMZV5VQTPV6Q2W5KQEZUMHBG7TDMKH6Q3JZXTPQ7YRPLSAVQLKL2';
    mockRecordPaymentOnChain.mockResolvedValue(true);
    mockGetAgent.mockResolvedValue({ score: 100 });

    const bodyA = validBody;
    const bodyB = { amountUsdc: '0.002', success: false, serviceId: 2 };
    const sigA = signBody(bodyA);
    const sigB = signBody(bodyB);

    const resA = await request(app)
      .post(`/api/agents/${agentAddress}/payment`)
      .set('X-Lodestar-Signature', sigA)
      .set('X-Idempotency-Key', 'shared-key')
      .send(bodyA);

    const resB = await request(app)
      .post(`/api/agents/${agentB}/payment`)
      .set('X-Lodestar-Signature', sigB)
      .set('X-Idempotency-Key', 'shared-key') // same key, different agent
      .send(bodyB);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(mockRecordPaymentOnChain).toHaveBeenCalledTimes(2); // both go through
  });

  it('should return 429 when rate limit is exceeded', async () => {
    const body = { amountUsdc: '0.001', success: true, serviceId: 2 };
    const signature = signBody(body);

    // Fire 10 requests with unique idempotency keys (limit is 10)
    for (let i = 0; i < 10; i++) {
      mockRecordPaymentOnChain.mockResolvedValueOnce(true);
      mockGetAgent.mockResolvedValueOnce({ score: 100 });
      await request(app)
        .post(`/api/agents/${agentAddress}/payment`)
        .set('X-Lodestar-Signature', signature)
        .set('X-Idempotency-Key', `rate-limit-key-${i}`)
        .send(body);
    }

    // 11th request with a fresh key should be rate-limited
    const res = await request(app)
      .post(`/api/agents/${agentAddress}/payment`)
      .set('X-Lodestar-Signature', signature)
      .set('X-Idempotency-Key', 'rate-limit-key-11')
      .send(body);

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });
});

describe('GET /api/agents/:address/payment-history', () => {
  const agentAddress = 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ';
  const otherAddress = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPGKAMRQTLQHKF7XQEWZMPOKJ3H';

  function makeEntry(agent, overrides = {}) {
    return { timestamp: '2025-01-01T00:00:00Z', agent, service: 'TestSvc', amount: '0.001', txHash: 'abc123', ...overrides };
  }

  beforeEach(() => {
    mockGetActivityFeed.mockReset();
  });

  it('returns only entries matching the agent address', async () => {
    mockGetActivityFeed.mockReturnValue([
      makeEntry(agentAddress, { txHash: 'tx1' }),
      makeEntry(otherAddress, { txHash: 'tx2' }),
      makeEntry(agentAddress, { txHash: 'tx3' }),
    ]);

    const res = await request(app).get(`/api/agents/${agentAddress}/payment-history`);

    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(2);
    expect(res.body.payments.every((e) => e.agent === agentAddress)).toBe(true);
    expect(res.body.total).toBe(2);
  });

  it('returns empty list when agent has no payment history', async () => {
    mockGetActivityFeed.mockReturnValue([makeEntry(otherAddress)]);

    const res = await request(app).get(`/api/agents/${agentAddress}/payment-history`);

    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(0);
    expect(res.body.total).toBe(0);
    expect(res.body.hasMore).toBe(false);
  });

  it('respects limit and offset pagination', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry(agentAddress, { txHash: `tx${i}` }));
    mockGetActivityFeed.mockReturnValue(entries);

    const res = await request(app).get(`/api/agents/${agentAddress}/payment-history?limit=2&offset=1`);

    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.hasMore).toBe(true);
  });
});
