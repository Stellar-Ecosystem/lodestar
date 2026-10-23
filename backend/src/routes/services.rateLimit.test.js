import { vi, describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../lib/contract.js', () => ({
  recordPaymentOnChain: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock('../lib/activityFeed.js', () => ({
  recordActivity: vi.fn(),
  getActivityFeed: vi.fn(() => []),
  parseActivityPagination: vi.fn(() => ({ limit: 20, offset: 0, errors: [] })),
  ACTIVITY_MAX_ENTRIES: 500,
  ACTIVITY_DEFAULT_LIMIT: 20,
  ACTIVITY_MAX_LIMIT: 100,
}));

vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// The weather ceiling is deliberately low here so the limit fires inside the
// test; the value under test is the wiring, not the number.
vi.mock('../config.js', () => ({
  default: {
    contract: { agentsId: 'mock-agents-contract' },
    server: { address: 'mock_address', secret: 'mock_secret' },
    x402: {
      facilitatorUrl: 'https://mock',
      weatherPrice: '0.001',
      searchPrice: '0.001',
      payTo: 'G_MOCK_PAYMENT',
    },
    braveApiKey: 'mock_key',
    corsOrigin: ['http://localhost:3000'],
    nodeEnv: 'test',
    port: 3001,
    logLevel: 'silent',
    rateLimit: {
      windowMs: 60_000,
      max: 20,
      payment: { windowMs: 60_000, max: 10 },
      weather: { windowMs: 60_000, max: 2 },
    },
  },
}));

// Bypass x402 payment middleware in tests
vi.mock('@x402/express', () => ({
  paymentMiddlewareFromConfig: () => (_req, _res, next) => next(),
}));
vi.mock('@x402/core/server', () => ({
  HTTPFacilitatorClient: vi.fn(() => ({})),
}));
vi.mock('@x402/stellar/exact/server', () => ({
  ExactStellarScheme: vi.fn(() => ({})),
}));

let app;

beforeAll(async () => {
  const router = (await import('./services.js')).default;
  app = express();
  app.use(express.json());
  app.use('/demo', router);
});

describe('GET /demo/weather rate limit (#674)', () => {
  it('answers 429 with Retry-After once the ceiling is reached', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        current: { temperature_2m: 20, wind_speed_10m: 5, weather_code: 1, time: 'now' },
      }),
    });

    const first = await request(app).get('/demo/weather?lat=0&lon=0');
    expect(first.status).toBe(200);

    const second = await request(app).get('/demo/weather?lat=0&lon=0');
    expect(second.status).toBe(200);

    const third = await request(app).get('/demo/weather?lat=0&lon=0');
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('RATE_LIMITED');
    expect(third.headers['retry-after']).toBe('60');
    // The throttled request must not have reached the upstream provider.
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
