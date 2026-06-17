import { vi, describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockListServices = vi.fn();

vi.mock('../lib/contract.js', () => ({
  listServices: (...args) => mockListServices(...args),
}));

vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
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
