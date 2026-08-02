import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';

vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { validate, formatIssues, buildValidationError } = await import('./validate.js');

/** Mount one validated route and return an app ready for supertest. */
function appWith(spec, handler = (req, res) => res.json({ valid: req.valid })) {
  const app = express();
  app.use(express.json());
  app.post('/things/:id', validate(spec), handler);
  app.get('/things/:id', validate(spec), handler);
  return app;
}

describe('validate — response shape', () => {
  it('returns error, code, and details on every failure', async () => {
    const app = appWith({
      request: { body: z.object({ name: z.string().min(3, { error: '`name` is too short' }) }) },
    });

    const res = await request(app).post('/things/1').send({ name: 'ab' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: '`name` is too short',
      code: 'INVALID_BODY',
      details: [{ path: 'name', message: '`name` is too short', rule: 'too_small' }],
    });
  });

  it('reports every problem at once, not just the first', async () => {
    const app = appWith({
      request: {
        body: z.object({
          name: z.string({ error: 'name required' }),
          email: z.string({ error: 'email required' }),
        }),
      },
    });

    const res = await request(app).post('/things/1').send({});

    expect(res.body.details).toEqual([
      { path: 'name', message: 'name required', rule: 'invalid_type' },
      { path: 'email', message: 'email required', rule: 'invalid_type' },
    ]);
    // `error` stays a single sentence — the first problem — so existing
    // clients that only render `error` keep working.
    expect(res.body.error).toBe('name required');
  });

  it('renders nested and array paths in dotted form', () => {
    const schema = z.object({ tags: z.array(z.string()) });
    const { error } = schema.safeParse({ tags: ['ok', 42] });

    expect(formatIssues(error.issues)).toEqual([
      { path: 'tags.1', message: expect.any(String), rule: 'invalid_type' },
    ]);
  });
});

describe('validate — error codes', () => {
  it('defaults to a per-source code', () => {
    const issues = [{ path: ['x'], message: 'bad', code: 'custom' }];
    expect(buildValidationError('query', {}, issues).code).toBe('INVALID_QUERY');
    expect(buildValidationError('params', {}, issues).code).toBe('INVALID_PARAMS');
  });

  it('prefers the code the route declares', async () => {
    const app = appWith({
      request: {
        params: { schema: z.object({ id: z.string().regex(/^\d+$/) }), code: 'INVALID_ID' },
      },
    });

    const res = await request(app).get('/things/abc');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  it('lets an issue override the route code, so one schema can raise two codes', async () => {
    const app = appWith({
      request: {
        body: {
          schema: z.object({
            key: z
              .string({ error: 'key missing' })
              .refine((v) => v.length < 5, {
                error: 'key malformed',
                params: { code: 'KEY_INVALID' },
              }),
          }),
          code: 'KEY_MISSING',
        },
      },
    });

    const missing = await request(app).post('/things/1').send({});
    expect(missing.body.code).toBe('KEY_MISSING');

    const malformed = await request(app).post('/things/1').send({ key: 'far-too-long' });
    expect(malformed.body.code).toBe('KEY_INVALID');
  });

  it('uses the route message when one is declared', async () => {
    const app = appWith({
      request: {
        params: {
          schema: z.object({ id: z.string().regex(/^\d+$/) }),
          code: 'INVALID_ID',
          message: 'Invalid service ID',
        },
      },
    });

    const res = await request(app).get('/things/abc');

    expect(res.body.error).toBe('Invalid service ID');
    // The underlying detail is still there for anyone who wants it.
    expect(res.body.details).toHaveLength(1);
  });
});

describe('validate — ordering', () => {
  it('reports a bad path param before complaining about the body it carried', async () => {
    const app = appWith({
      request: {
        params: { schema: z.object({ id: z.string().regex(/^\d+$/) }), code: 'INVALID_ID' },
        body: z.object({ name: z.string() }),
      },
    });

    const res = await request(app).post('/things/abc').send({});

    expect(res.body.code).toBe('INVALID_ID');
  });
});

describe('validate — parsed output', () => {
  let received;

  beforeEach(() => {
    received = null;
  });

  it('hands the handler coerced values on req.valid', async () => {
    const app = appWith(
      {
        request: {
          params: z.object({ id: z.string().transform(Number) }),
          query: z.object({ page: z.string().transform(Number).optional().default(0) }),
          body: z.object({ name: z.string().trim() }),
        },
      },
      (req, res) => {
        received = req.valid;
        res.json({ ok: true });
      },
    );

    await request(app).post('/things/42?page=3').send({ name: '  spaced  ' });

    expect(received).toEqual({
      params: { id: 42 },
      query: { page: 3 },
      body: { name: 'spaced' },
    });
  });

  it('applies declared defaults when a param is absent', async () => {
    const app = appWith(
      { request: { query: z.object({ page: z.string().transform(Number).optional().default(0) }) } },
      (req, res) => {
        received = req.valid;
        res.json({ ok: true });
      },
    );

    await request(app).get('/things/1');

    expect(received.query).toEqual({ page: 0 });
  });

  it('treats a missing body as an empty object rather than throwing', async () => {
    const app = appWith({
      request: { body: z.object({ name: z.string({ error: '`name` is required' }) }) },
    });

    const res = await request(app).post('/things/1');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('`name` is required');
  });

  it('passes a request through untouched when the route declares no schemas', async () => {
    const app = appWith({ request: {} }, (req, res) => {
      received = req.valid;
      res.json({ ok: true });
    });

    const res = await request(app).get('/things/anything');

    expect(res.status).toBe(200);
    expect(received).toEqual({});
  });
});
