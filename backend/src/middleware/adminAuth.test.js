import { vi, describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

const MOCK_SECRET = vi.hoisted(() => 'test-admin-secret-67890');

vi.mock('../config.js', () => ({
  default: {
    server: {
      secret: MOCK_SECRET,
    },
  },
}));

vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// Spy on crypto.timingSafeEqual BEFORE importing the middleware so the spy
// is in place before the module-level import resolves.
const timingSafeEqualSpy = vi.spyOn(crypto, 'timingSafeEqual');

import { adminAuth } from './adminAuth.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/admin', adminAuth, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

/** Compute the expected HMAC-SHA256 hex digest for given body + secret. */
function validKey(body) {
  return crypto.createHmac('sha256', MOCK_SECRET).update(JSON.stringify(body)).digest('hex');
}

describe('adminAuth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Valid key ──────────────────────────────────────────────────────

  it('accepts a request with a valid X-Admin-Key', async () => {
    const app = makeApp();
    const body = { action: 'flag-agent' };
    const res = await request(app)
      .post('/admin')
      .set('X-Admin-Key', validKey(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('accepts a request with an empty body and matching key', async () => {
    const app = makeApp();
    const body = {};
    const res = await request(app)
      .post('/admin')
      .set('X-Admin-Key', validKey(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  // ── Missing header ─────────────────────────────────────────────────

  it('rejects a request when X-Admin-Key header is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/admin').send({});

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ADMIN_KEY_MISSING');
    expect(res.body.error).toMatch(/Missing/);
  });

  // ── Malformed / empty-string header ────────────────────────────────

  it('rejects a request when X-Admin-Key header is an empty string', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/admin')
      .set('x-admin-key', '')
      .send({});

    // empty string is falsy → caught by !key guard, returns ADMIN_KEY_MISSING
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ADMIN_KEY_MISSING');
  });

  // ── Invalid key ────────────────────────────────────────────────────

  it('rejects a request with an incorrect admin key (wrong secret)', async () => {
    const app = makeApp();
    const body = { test: true };
    const wrongKey = crypto
      .createHmac('sha256', 'wrong-secret')
      .update(JSON.stringify(body))
      .digest('hex');

    const res = await request(app)
      .post('/admin')
      .set('X-Admin-Key', wrongKey)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ADMIN_KEY_INVALID');
    expect(res.body.error).toMatch(/Invalid admin key/);
  });

  it('rejects a request with a completely arbitrary key', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/admin')
      .set('X-Admin-Key', 'some-random-garbage')
      .send({ foo: 'bar' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ADMIN_KEY_INVALID');
  });

  // ── Length-difference boundary ─────────────────────────────────────

  it('rejects when the key buffer length differs from the expected length', async () => {
    const app = makeApp();
    const body = { boundary: 'test' };
    // HMAC-SHA256 hex is 64 chars; send a 63-char hex string.
    const shortKey = 'a'.repeat(63);

    const res = await request(app)
      .post('/admin')
      .set('X-Admin-Key', shortKey)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ADMIN_KEY_INVALID');
  });

  it('rejects when the key buffer is longer than expected', async () => {
    const app = makeApp();
    const body = { boundary: 'test' };
    const longKey = 'b'.repeat(65);

    const res = await request(app)
      .post('/admin')
      .set('X-Admin-Key', longKey)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ADMIN_KEY_INVALID');
  });

  // ── Timing-safe comparison ─────────────────────────────────────────

  it('uses crypto.timingSafeEqual for key comparison', async () => {
    const app = makeApp();
    const body = { timing: 'safe' };
    const key = validKey(body);

    timingSafeEqualSpy.mockClear();

    await request(app)
      .post('/admin')
      .set('X-Admin-Key', key)
      .send(body);

    // timingSafeEqual should be called exactly once for the comparison
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);

    const [a, b] = timingSafeEqualSpy.mock.calls[0];
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(Buffer.isBuffer(b)).toBe(true);
    expect(a.length).toBe(b.length); // lengths must match for timingSafeEqual
  });

  it('does not call timingSafeEqual when the key is missing', async () => {
    const app = makeApp();
    timingSafeEqualSpy.mockClear();

    await request(app).post('/admin').send({});

    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
  });

  it('does not call timingSafeEqual when buffer lengths differ', async () => {
    const app = makeApp();
    timingSafeEqualSpy.mockClear();

    const body = { len: 'test' };
    const res = await request(app)
      .post('/admin')
      .set('X-Admin-Key', 'a'.repeat(32))
      .send(body);

    // Length differs (32 vs 64) — middleware short-circuits before timingSafeEqual
    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });
});
