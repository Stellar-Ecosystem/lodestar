import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { deactivateServiceOnChain } = vi.hoisted(() => ({
  deactivateServiceOnChain: vi.fn(),
}));

vi.mock('../lib/contract.js', () => ({
  listServices: vi.fn(),
  listServicesByProvider: vi.fn(),
  getService: vi.fn(),
  getServiceCount: vi.fn(),
  deactivateServiceOnChain,
  updateReputation: vi.fn(),
  isAllowedReputationAgent: vi.fn(),
  buildUnsignedRegistryTx: vi.fn(),
  validatePreparedRegistrySubmission: vi.fn(),
  submitSignedRegistryTx: vi.fn(),
  SERVICE_MAX_TTL: 3_110_400,
  SERVICE_TTL_WARNING_LEDGERS: 311_040,
}));
vi.mock('../lib/stellar.js', () => ({ getCurrentLedgerSequence: vi.fn() }));
vi.mock('../lib/reputationHistory.js', () => ({ getReputationHistory: vi.fn() }));
vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../config.js', () => ({
  default: {
    // Deliberately different defaults prove the route supplies its own ceiling.
    rateLimit: { max: 100, windowMs: 900_000 },
  },
}));

const PROVIDER = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';
let app;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  // Only fake Date: HTTP sockets and the limiter's cleanup timers remain real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  deactivateServiceOnChain.mockResolvedValue({ xdr: 'unsigned-xdr', submitToken: 'token' });
  const router = (await import('./registry.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api', router);
});

afterEach(() => vi.useRealTimers());

function deactivate(id = 7, providerAddress = PROVIDER) {
  return request(app).post(`/api/services/${id}/deactivate`).send({ providerAddress });
}

describe('deactivation route rate limit', () => {
  it('allows five attempts across service IDs, blocks RPC on the sixth, and recovers after a minute', async () => {
    for (let id = 1; id <= 5; id++) {
      const response = await deactivate(id);
      expect(response.status).toBe(200);
      expect(response.body.xdr).toBe('unsigned-xdr');
    }
    expect(deactivateServiceOnChain).toHaveBeenCalledTimes(5);

    const blocked = await deactivate(99);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBe('60');
    expect(deactivateServiceOnChain).toHaveBeenCalledTimes(5);

    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
    const retry = await deactivate();
    expect(retry.status).toBe(429);
    expect(retry.headers['retry-after']).toBe('30');
    expect(deactivateServiceOnChain).toHaveBeenCalledTimes(5);

    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
    expect((await deactivate()).status).toBe(200);
    expect(deactivateServiceOnChain).toHaveBeenCalledTimes(6);
  });

  it('counts invalid submissions before validation without reaching RPC', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await deactivate(7, 'invalid-provider')).status).toBe(400);
    }
    const response = await deactivate();
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
    expect(deactivateServiceOnChain).not.toHaveBeenCalled();
  });
});
