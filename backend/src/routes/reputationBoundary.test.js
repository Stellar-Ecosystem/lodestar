import { vi, describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  clearReputationHistory,
  getReputationHistory,
  recordReputationChange,
} from '../lib/reputationHistory.js';

const VALID_AGENT = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';
const FIXED_TIMESTAMP = 1_700_000_000_000;

const mockUpdateReputation = vi.fn();
const mockIsAllowedReputationAgent = vi.fn();
const mockGetService = vi.fn();
const mockGetCurrentLedgerSequence = vi.fn();

vi.mock('../lib/contract.js', () => ({
  listServices: vi.fn(),
  listServicesByProvider: vi.fn(),
  getService: (...args) => mockGetService(...args),
  getServiceCount: vi.fn(),
  deactivateServiceOnChain: vi.fn(),
  updateReputation: (...args) => mockUpdateReputation(...args),
  isAllowedReputationAgent: (...args) => mockIsAllowedReputationAgent(...args),
  buildUnsignedRegistryTx: vi.fn(),
  validatePreparedRegistrySubmission: vi.fn(),
  submitSignedRegistryTx: vi.fn(),
  SERVICE_MAX_TTL: 3_110_400,
  SERVICE_TTL_WARNING_LEDGERS: 311_040,
}));

vi.mock('../lib/stellar.js', () => ({
  getCurrentLedgerSequence: (...args) => mockGetCurrentLedgerSequence(...args),
}));

const logLines = [];

function createMockLogger(bindings = {}) {
  const record = (level) => (obj, msg) => {
    logLines.push({ level, ...bindings, ...(obj ?? {}), msg });
  };
  return {
    error: record('error'),
    info: record('info'),
    warn: record('warn'),
    debug: record('debug'),
    child: vi.fn((extra) => createMockLogger({ ...bindings, ...extra })),
  };
}

vi.mock('../lib/logger.js', () => ({
  default: createMockLogger(),
}));

vi.mock('../middleware/rateLimiter.js', () => ({
  writeRateLimiter: () => (_req, _res, next) => next(),
}));

let app;

beforeAll(async () => {
  const router = (await import('./registry.js')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'req-1182';
    next();
  });
  app.use('/api', router);
});

function makeService(overrides = {}) {
  return {
    id: 1,
    name: 'Boundary Service',
    description: 'A test service description',
    endpoint: 'https://test.example.com',
    price_usdc: '1.00',
    category: 'test',
    provider: VALID_AGENT,
    reputation: 999,
    active: true,
    registered_at: 1000,
    ...overrides,
  };
}

function vote(body = { positive: true, agent: VALID_AGENT }) {
  return request(app).post('/api/reputation/1').send(body);
}

function mockVotingResult(newValue, delta = 1) {
  mockUpdateReputation.mockImplementation(async (id) => {
    recordReputationChange(id, FIXED_TIMESTAMP, delta, newValue);
    return newValue;
  });
}

describe('POST /api/reputation/:id — boundary and failure states (#1182)', () => {
  beforeEach(() => {
    clearReputationHistory();
    logLines.length = 0;
    mockUpdateReputation.mockReset();
    mockIsAllowedReputationAgent.mockReset();
    mockGetService.mockReset();
    mockGetCurrentLedgerSequence.mockReset();
    mockIsAllowedReputationAgent.mockReturnValue(true);
    mockGetService.mockResolvedValue(makeService());
  });

  it.each([
    ['lower', 0],
    ['upper', 1000],
  ])('returns and records exactly one result at the %s score boundary (%i)', async (_boundary, newValue) => {
    mockVotingResult(newValue);

    const res = await vote();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, newReputation: newValue });
    expect(mockUpdateReputation).toHaveBeenCalledTimes(1);
    expect(mockUpdateReputation).toHaveBeenCalledWith(1, true, VALID_AGENT);
    expect(getReputationHistory(1)).toEqual([
      { timestamp: FIXED_TIMESTAMP, delta: 1, newValue },
    ]);

    const history = await request(app).get('/api/services/1/history');
    expect(history.status).toBe(200);
    expect(history.body).toEqual({
      history: [{ timestamp: FIXED_TIMESTAMP, delta: 1, newValue }],
    });
  });

  it('answers a safe 504 and records no result when the RPC exceeds REPUTATION_TIMEOUT_MS', async () => {
    const { default: config } = await import('../config.js');
    let signalStarted;
    const started = new Promise((resolve) => {
      signalStarted = resolve;
    });
    mockUpdateReputation.mockImplementation(() => {
      signalStarted();
      return new Promise(() => {});
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const pending = vote().then((res) => res);
      await started;
      await vi.advanceTimersByTimeAsync(config.upstreamTimeout.reputationMs + 1);
      const res = await pending;

      expect(res.status).toBe(504);
      expect(res.body).toEqual({
        error: expect.any(String),
        code: 'UPSTREAM_TIMEOUT',
      });
      expect(res.body).not.toHaveProperty('success');
      expect(res.body).not.toHaveProperty('newReputation');
    } finally {
      vi.useRealTimers();
    }

    expect(mockUpdateReputation).toHaveBeenCalledTimes(1);
    expect(getReputationHistory(1)).toEqual([]);

    const line = logLines.find((entry) => entry.outcome === 'timeout');
    expect(line).toBeDefined();
    expect(line).toMatchObject({
      level: 'warn',
      code: 'UPSTREAM_TIMEOUT',
      serviceId: 1,
      requestId: 'req-1182',
    });
    expect(line).not.toHaveProperty('agent');
    expect(line).not.toHaveProperty('body');
  });

  it('does not record a result when the vote is rejected', async () => {
    mockIsAllowedReputationAgent.mockReturnValue(false);

    const res = await vote();

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AGENT_NOT_ALLOWED');
    expect(res.body).not.toHaveProperty('success');
    expect(res.body).not.toHaveProperty('newReputation');
    expect(mockUpdateReputation).not.toHaveBeenCalled();
    expect(getReputationHistory(1)).toEqual([]);
    expect(logLines.find((entry) => entry.outcome === 'forbidden')).toMatchObject({
      level: 'warn',
      serviceId: 1,
      requestId: 'req-1182',
    });
  });

  it('does not duplicate effects when two votes are submitted in sequence', async () => {
    mockUpdateReputation
      .mockImplementationOnce(async (id) => {
        recordReputationChange(id, FIXED_TIMESTAMP, 1, 0);
        return 0;
      })
      .mockImplementationOnce(async (id) => {
        recordReputationChange(id, FIXED_TIMESTAMP + 1, 1, 1);
        return 1;
      });

    const first = await vote();
    const second = await vote({ positive: false, agent: VALID_AGENT });

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ success: true, newReputation: 0 });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ success: true, newReputation: 1 });
    expect(mockUpdateReputation).toHaveBeenCalledTimes(2);
    expect(getReputationHistory(1)).toEqual([
      { timestamp: FIXED_TIMESTAMP + 1, delta: 1, newValue: 1 },
      { timestamp: FIXED_TIMESTAMP, delta: 1, newValue: 0 },
    ]);
  });
});
