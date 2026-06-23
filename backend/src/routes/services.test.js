import { vi, describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockRecordPaymentOnChain = vi.fn();
const mockRecordActivity = vi.fn();

vi.mock('../lib/contract.js', () => ({
  recordPaymentOnChain: (...args) => mockRecordPaymentOnChain(...args),
}));

vi.mock('../lib/activityFeed.js', () => ({
  recordActivity: (...args) => mockRecordActivity(...args),
  getActivityFeed: vi.fn(() => []),
  parseActivityPagination: vi.fn(() => ({ limit: 20, offset: 0, errors: [] })),
  ACTIVITY_MAX_ENTRIES: 500,
  ACTIVITY_DEFAULT_LIMIT: 20,
  ACTIVITY_MAX_LIMIT: 100,
}));

vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config.js', () => ({
  default: {
    contract: { agentsId: null },
    server: { address: 'mock_address', secret: 'mock_secret' },
    x402: { facilitatorUrl: 'https://mock', weatherPrice: '0.001', searchPrice: '0.001', payTo: 'G_MOCK_PAYMENT' },
    braveApiKey: 'mock_key',
    corsOrigin: ['http://localhost:3000'],
    nodeEnv: 'test',
    port: 3001,
    logLevel: 'silent',
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

describe('GET /demo/weather coordinate validation', () => {
  it('returns 400 INVALID_COORDINATES when lat is above 90', async () => {
    const res = await request(app).get('/demo/weather?lat=91&lon=0');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_COORDINATES');
  });

  it('returns 400 INVALID_COORDINATES when lat is below -90', async () => {
    const res = await request(app).get('/demo/weather?lat=-91&lon=0');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_COORDINATES');
  });

  it('returns 400 INVALID_COORDINATES when lon is above 180', async () => {
    const res = await request(app).get('/demo/weather?lat=0&lon=181');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_COORDINATES');
  });

  it('returns 400 INVALID_COORDINATES when lon is below -180', async () => {
    const res = await request(app).get('/demo/weather?lat=0&lon=-181');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_COORDINATES');
  });

  it('accepts valid boundary coordinates (90, 180)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ current: { temperature_2m: 20, wind_speed_10m: 5, weather_code: 1, time: 'now' } }),
    });
    const res = await request(app).get('/demo/weather?lat=90&lon=180');
    expect(res.status).toBe(200);
    expect(res.body.latitude).toBe(90);
    expect(res.body.longitude).toBe(180);
  });

  it('accepts valid boundary coordinates (-90, -180)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ current: { temperature_2m: -5, wind_speed_10m: 10, weather_code: 3, time: 'now' } }),
    });
    const res = await request(app).get('/demo/weather?lat=-90&lon=-180');
    expect(res.status).toBe(200);
    expect(res.body.latitude).toBe(-90);
    expect(res.body.longitude).toBe(-180);
  });

  it('falls back to default coordinates when no query params supplied', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ current: { temperature_2m: 22, wind_speed_10m: 3, weather_code: 0, time: 'now' } }),
    });
    const res = await request(app).get('/demo/weather');
    expect(res.status).toBe(200);
    expect(res.body.latitude).toBe(40.7128);
    expect(res.body.longitude).toBe(-74.006);
  });
});
