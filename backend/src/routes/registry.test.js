import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockListServices = vi.fn();
const mockGetService = vi.fn();
const mockGetServiceCount = vi.fn();
const mockGetReputationHistory = vi.fn();
const mockUpdateReputation = vi.fn();
const mockIsAllowedReputationAgent = vi.fn();
const mockGetCurrentLedgerSequence = vi.fn();

// Must match the exports added to contract.js
const SERVICE_MAX_TTL = 3_110_400;
const SERVICE_TTL_WARNING_LEDGERS = 311_040;

vi.mock('../lib/contract.js', () => ({
  listServices: (...args) => mockListServices(...args),
  getService: (...args) => mockGetService(...args),
  getServiceCount: (...args) => mockGetServiceCount(...args),
  updateReputation: (...args) => mockUpdateReputation(...args),
  isAllowedReputationAgent: (...args) => mockIsAllowedReputationAgent(...args),
  SERVICE_MAX_TTL: 3_110_400,
  SERVICE_TTL_WARNING_LEDGERS: 311_040,
}));

vi.mock('../lib/stellar.js', () => ({
  getCurrentLedgerSequence: (...args) => mockGetCurrentLedgerSequence(...args),
}));

vi.mock('../lib/reputationHistory.js', () => ({
  getReputationHistory: (...args) => mockGetReputationHistory(...args),
}));

vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// Rate limiting is verified in isolation in middleware/rateLimiter.test.js;
// here it's a pass-through so route behavior can be tested without throttling.
vi.mock('../middleware/rateLimiter.js', () => ({
  writeRateLimiter: () => (_req, _res, next) => next(),
}));

let app;

beforeAll(async () => {
  const router = (await import('./registry.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api', router);
});

function makeService(overrides = {}) {
  return {
    id: 1,
    name: 'Test Service',
    description: 'A test service description',
    endpoint: 'https://test.example.com',
    price_usdc: '1.00',
    category: 'test',
    provider: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
    reputation: 100,
    active: true,
    registered_at: 1000,
    ...overrides,
  };
}

describe('GET /api/services', () => {
  it('should return all services when no q param', async () => {
    const services = [makeService({ id: 1 }), makeService({ id: 2, name: 'Other' })];
    mockListServices.mockResolvedValueOnce(services);

    const res = await request(app).get('/api/services');

    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(2);
    expect(res.body.count).toBe(2);
  });

  it('should filter by name with case-insensitive substring match', async () => {
    const services = [
      makeService({ id: 1, name: 'Weather API', description: 'Get forecast data' }),
      makeService({ id: 2, name: 'Search Engine', description: 'Web search service' }),
      makeService({ id: 3, name: 'Image Processor', description: 'AI image processing' }),
    ];
    mockListServices.mockResolvedValueOnce(services);

    const res = await request(app).get('/api/services?q=weather');

    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(1);
    expect(res.body.services[0].id).toBe(1);
    expect(res.body.count).toBe(1);
  });

  it('should match across both name and description', async () => {
    const services = [
      makeService({ id: 1, name: 'Weather API', description: 'Get forecast data' }),
      makeService({ id: 2, name: 'Search Engine', description: 'Weather web search' }),
      makeService({ id: 3, name: 'Image Processor', description: 'AI image processing' }),
    ];
    mockListServices.mockResolvedValueOnce(services);

    const res = await request(app).get('/api/services?q=weather');

    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(2);
    expect(res.body.services.map((s) => s.id)).toEqual([1, 2]);
    expect(res.body.count).toBe(2);
  });

  it('should filter by description with case-insensitive substring match', async () => {
    const services = [
      makeService({ id: 1, name: 'Alpha', description: 'Blockchain data service' }),
      makeService({ id: 2, name: 'Beta', description: 'AI assistant service' }),
    ];
    mockListServices.mockResolvedValueOnce(services);

    const res = await request(app).get('/api/services?q=blockchain');

    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(1);
    expect(res.body.services[0].id).toBe(1);
    expect(res.body.count).toBe(1);
  });

  it('should be case-insensitive', async () => {
    const services = [
      makeService({ id: 1, name: 'Weather API', description: 'Get WEATHER data' }),
      makeService({ id: 2, name: 'weather bot', description: 'forecast tool' }),
    ];
    mockListServices.mockResolvedValueOnce(services);

    const res = await request(app).get('/api/services?q=WEATHER');

    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(2);
    expect(res.body.count).toBe(2);
  });

  it('should return empty array when no services match', async () => {
    mockListServices.mockResolvedValueOnce([makeService({ name: 'Foo' })]);

    const res = await request(app).get('/api/services?q=nonexistent');

    expect(res.status).toBe(200);
    expect(res.body.services).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it('should return all services when q is empty string', async () => {
    const services = [makeService({ id: 1 }), makeService({ id: 2 })];
    mockListServices.mockResolvedValueOnce(services);

    const res = await request(app).get('/api/services?q=');

    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(2);
    expect(res.body.count).toBe(2);
  });

  it('should return 500 when contract call fails', async () => {
    mockListServices.mockRejectedValueOnce(new Error('Chain error'));

    const res = await request(app).get('/api/services');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch services', code: 'FETCH_ERROR' });
  });

  it('should return 400 when contract call throws ContractError SIMULATION_FAILED', async () => {
    const { ContractError } = await import('../lib/ContractError.js');
    mockListServices.mockRejectedValueOnce(new ContractError('Simulation failed', 'SIMULATION_FAILED'));

    const res = await request(app).get('/api/services');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Simulation failed', code: 'SIMULATION_FAILED' });
  });

  it('should return 504 when contract call throws ContractError TRANSACTION_TIMEOUT', async () => {
    const { ContractError } = await import('../lib/ContractError.js');
    mockListServices.mockRejectedValueOnce(new ContractError('Transaction timeout', 'TRANSACTION_TIMEOUT'));

    const res = await request(app).get('/api/services');

    expect(res.status).toBe(504);
    expect(res.body).toEqual({ error: 'Transaction timeout', code: 'TRANSACTION_TIMEOUT' });
  });

  it('should support both category and q params together', async () => {
    const services = [
      makeService({ id: 1, name: 'Weather API', category: 'data' }),
      makeService({ id: 2, name: 'Weather Bot', category: 'data' }),
      makeService({ id: 3, name: 'Search Engine', category: 'search' }),
    ];
    mockListServices.mockResolvedValueOnce(services);

    const res = await request(app).get('/api/services?category=data&q=bot');

    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(1);
    expect(res.body.services[0].id).toBe(2);
    expect(res.body.count).toBe(1);
  });

  it('should handle services with null name or description', async () => {
    const services = [
      makeService({ id: 1, name: null, description: 'only description' }),
      makeService({ id: 2, name: 'only name', description: null }),
      makeService({ id: 3, name: null, description: null }),
    ];
    mockListServices.mockResolvedValueOnce(services);

    const res = await request(app).get('/api/services?q=only');

    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(2);
    expect(res.body.services.map((s) => s.id)).toEqual([1, 2]);
    expect(res.body.count).toBe(2);
  });
});

describe('POST /api/reputation/:id — request body size limit', () => {
  let app;

  beforeAll(async () => {
    const router = (await import('./registry.js')).default;
    app = express();
    app.use(express.json({ limit: '100' }));
    app.use('/api', router);
    app.use((err, _req, res, _next) => {
      if (err.type === 'entity.too.large') {
        return res.status(413).json({
          error: `Request body too large. Maximum size is 100.`,
          code: 'PAYLOAD_TOO_LARGE',
        });
      }
      res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    });
  });

  it('should return 413 when JSON body exceeds size limit', async () => {
    const oversized = { positive: 'x'.repeat(200) };

    const res = await request(app)
      .post('/api/reputation/1')
      .send(oversized);

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: 'Request body too large. Maximum size is 100.',
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('should accept payload within size limit (not 413)', async () => {
    const res = await request(app)
      .post('/api/reputation/1')
      .send({ positive: true });

    expect(res.status).not.toBe(413);
  });
});

describe('POST /api/reputation/:id — authorization', () => {
  const VALID_AGENT = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';

  beforeEach(() => {
    mockUpdateReputation.mockReset();
    mockIsAllowedReputationAgent.mockReset();
  });

  it('should return 400 when `positive` is missing', async () => {
    const res = await request(app)
      .post('/api/reputation/1')
      .send({ agent: VALID_AGENT });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    expect(mockUpdateReputation).not.toHaveBeenCalled();
  });

  it('should return 400 when `agent` is missing', async () => {
    const res = await request(app)
      .post('/api/reputation/1')
      .send({ positive: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    expect(mockUpdateReputation).not.toHaveBeenCalled();
  });

  it('should return 400 when `agent` is not a valid Stellar address', async () => {
    const res = await request(app)
      .post('/api/reputation/1')
      .send({ positive: true, agent: 'not-an-address' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
    expect(mockUpdateReputation).not.toHaveBeenCalled();
  });

  it('should return 403 when the agent is not allowlisted', async () => {
    mockIsAllowedReputationAgent.mockReturnValue(false);

    const res = await request(app)
      .post('/api/reputation/1')
      .send({ positive: true, agent: VALID_AGENT });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AGENT_NOT_ALLOWED');
    expect(mockUpdateReputation).not.toHaveBeenCalled();
  });

  it('should update reputation for an allowlisted agent', async () => {
    mockIsAllowedReputationAgent.mockReturnValue(true);
    mockUpdateReputation.mockResolvedValueOnce(5);

    const res = await request(app)
      .post('/api/reputation/1')
      .send({ positive: true, agent: VALID_AGENT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, newReputation: 5 });
    expect(mockUpdateReputation).toHaveBeenCalledWith(1, true, VALID_AGENT);
  });

  it('should surface the on-chain cooldown rejection as an actionable 400', async () => {
    const { ContractError } = await import('../lib/ContractError.js');
    mockIsAllowedReputationAgent.mockReturnValue(true);
    mockUpdateReputation.mockRejectedValueOnce(
      new ContractError('Simulation failed: cooldown', 'SIMULATION_FAILED'),
    );

    const res = await request(app)
      .post('/api/reputation/1')
      .send({ positive: true, agent: VALID_AGENT });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SIMULATION_FAILED');
  });

  it('should return 500 on an unexpected error', async () => {
    mockIsAllowedReputationAgent.mockReturnValue(true);
    mockUpdateReputation.mockRejectedValueOnce(new Error('boom'));

    const res = await request(app)
      .post('/api/reputation/1')
      .send({ positive: true, agent: VALID_AGENT });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('UPDATE_ERROR');
  });
});

describe('GET /api/services/:id/history', () => {
  it('should return empty history for a service with no changes', async () => {
    mockGetService.mockResolvedValueOnce(makeService({ id: 1 }));
    mockGetReputationHistory.mockReturnValueOnce([]);

    const res = await request(app).get('/api/services/1/history');

    expect(res.status).toBe(200);
    expect(res.body.history).toEqual([]);
  });

  it('should return history for a service with changes', async () => {
    const history = [
      { timestamp: 1718170000000, delta: 1, newValue: 1 },
      { timestamp: 1718170100000, delta: 1, newValue: 2 },
    ];
    mockGetService.mockResolvedValueOnce(makeService({ id: 1 }));
    mockGetReputationHistory.mockReturnValueOnce(history);

    const res = await request(app).get('/api/services/1/history');

    expect(res.status).toBe(200);
    expect(res.body.history).toEqual(history);
  });

  it('should return 400 for invalid service ID', async () => {
    const res = await request(app).get('/api/services/invalid/history');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid service ID');
  });

  it('should return 404 if service does not exist', async () => {
    mockGetService.mockResolvedValueOnce(null);

    const res = await request(app).get('/api/services/999/history');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Service not found');
  });

  it('should return 500 when contract call fails', async () => {
    mockGetService.mockRejectedValueOnce(new Error('Chain error'));

    const res = await request(app).get('/api/services/1/history');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch reputation history', code: 'FETCH_ERROR' });
  });
});

// ── TTL warning annotation ─────────────────────────────────────────────────────
//
// registered_at = 1000
// expiry ledger  = 1000 + SERVICE_MAX_TTL               = 3_111_400
// warning onset  = 3_111_400 - SERVICE_TTL_WARNING_LEDGERS = 2_800_360

describe('GET /api/services — ttl_warning annotation', () => {
  const REGISTERED_AT = 1000;
  const EXPIRY = REGISTERED_AT + SERVICE_MAX_TTL;             // 3_111_400
  const WARN_ONSET = EXPIRY - SERVICE_TTL_WARNING_LEDGERS;    // 2_800_360

  beforeEach(() => {
    mockGetCurrentLedgerSequence.mockReset();
  });

  it('sets ttl_warning:false when ledger is well before the warning onset', async () => {
    mockListServices.mockResolvedValueOnce([makeService({ registered_at: REGISTERED_AT })]);
    mockGetCurrentLedgerSequence.mockResolvedValue(WARN_ONSET - 1);

    const res = await request(app).get('/api/services');

    expect(res.status).toBe(200);
    expect(res.body.services[0].ttl_warning).toBe(false);
  });

  it('sets ttl_warning:true exactly at the warning onset ledger', async () => {
    mockListServices.mockResolvedValueOnce([makeService({ registered_at: REGISTERED_AT })]);
    mockGetCurrentLedgerSequence.mockResolvedValue(WARN_ONSET);

    const res = await request(app).get('/api/services');

    expect(res.status).toBe(200);
    expect(res.body.services[0].ttl_warning).toBe(true);
  });

  it('sets ttl_warning:true past the warning onset (including at expiry)', async () => {
    mockListServices.mockResolvedValueOnce([makeService({ registered_at: REGISTERED_AT })]);
    mockGetCurrentLedgerSequence.mockResolvedValue(EXPIRY);

    const res = await request(app).get('/api/services');

    expect(res.status).toBe(200);
    expect(res.body.services[0].ttl_warning).toBe(true);
  });

  it('omits ttl_warning when getCurrentLedgerSequence fails (graceful degradation)', async () => {
    mockListServices.mockResolvedValueOnce([makeService({ registered_at: REGISTERED_AT })]);
    mockGetCurrentLedgerSequence.mockRejectedValue(new Error('RPC unreachable'));

    const res = await request(app).get('/api/services');

    expect(res.status).toBe(200);
    expect('ttl_warning' in res.body.services[0]).toBe(false);
  });

  it('annotates every service in the page independently', async () => {
    mockListServices.mockResolvedValueOnce([
      makeService({ id: 1, registered_at: REGISTERED_AT }),
      makeService({ id: 2, registered_at: REGISTERED_AT + 1_000_000 }),
    ]);
    // Ledger is past the warning onset for service 1 but not service 2
    const freshOnset = REGISTERED_AT + 1_000_000 + SERVICE_MAX_TTL - SERVICE_TTL_WARNING_LEDGERS;
    mockGetCurrentLedgerSequence.mockResolvedValue(WARN_ONSET);

    const res = await request(app).get('/api/services');

    expect(res.status).toBe(200);
    expect(res.body.services[0].ttl_warning).toBe(true);
    expect(res.body.services[1].ttl_warning).toBe(false);
  });
});

describe('GET /api/services/:id — ttl_warning annotation', () => {
  const REGISTERED_AT = 1000;
  const WARN_ONSET = REGISTERED_AT + SERVICE_MAX_TTL - SERVICE_TTL_WARNING_LEDGERS;

  beforeEach(() => {
    mockGetCurrentLedgerSequence.mockReset();
  });

  it('includes ttl_warning:false for a fresh entry', async () => {
    mockGetService.mockResolvedValueOnce(makeService({ registered_at: REGISTERED_AT }));
    mockGetCurrentLedgerSequence.mockResolvedValue(WARN_ONSET - 1);

    const res = await request(app).get('/api/services/1');

    expect(res.status).toBe(200);
    expect(res.body.ttl_warning).toBe(false);
  });

  it('includes ttl_warning:true when ledger crosses the warning onset', async () => {
    mockGetService.mockResolvedValueOnce(makeService({ registered_at: REGISTERED_AT }));
    mockGetCurrentLedgerSequence.mockResolvedValue(WARN_ONSET);

    const res = await request(app).get('/api/services/1');

    expect(res.status).toBe(200);
    expect(res.body.ttl_warning).toBe(true);
  });

  it('omits ttl_warning when ledger fetch fails (graceful degradation)', async () => {
    mockGetService.mockResolvedValueOnce(makeService({ registered_at: REGISTERED_AT }));
    mockGetCurrentLedgerSequence.mockRejectedValue(new Error('timeout'));

    const res = await request(app).get('/api/services/1');

    expect(res.status).toBe(200);
    expect('ttl_warning' in res.body).toBe(false);
  });
});
