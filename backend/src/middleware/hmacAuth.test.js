import { vi, describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

const MOCK_SECRET = vi.hoisted(() => 'test-hmac-secret-12345');

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

import { hmacAuth } from './hmacAuth.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/protected', hmacAuth, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

/** Compute the expected HMAC-SHA256 hex digest for given body + secret. */
function validSignature(body) {
  return crypto.createHmac('sha256', MOCK_SECRET).update(JSON.stringify(body)).digest('hex');
}

describe('hmacAuth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Valid signature ────────────────────────────────────────────────

  it('accepts a request with a valid X-Lodestar-Signature', async () => {
    const app = makeApp();
    const body = { key: 'value' };
    const res = await request(app)
      .post('/protected')
      .set('X-Lodestar-Signature', validSignature(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('accepts a request with an empty body and matching signature', async () => {
    const app = makeApp();
    const body = {};
    const res = await request(app)
      .post('/protected')
      .set('X-Lodestar-Signature', validSignature(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  // ── Missing header ─────────────────────────────────────────────────

  it('rejects a request when X-Lodestar-Signature header is missing', async () => {
    const app = makeApp();
    const res = await request(app).post('/protected').send({});

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('HMAC_MISSING');
    expect(res.body.error).toMatch(/Missing/);
  });

  // ── Malformed / empty-string header ────────────────────────────────

  it('rejects a request when X-Lodestar-Signature header is an empty string', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/protected')
      .set('x-lodestar-signature', '')
      .send({});

    // empty string is falsy → caught by !signature guard, returns HMAC_MISSING
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('HMAC_MISSING');
  });

  // ── Invalid signature ──────────────────────────────────────────────

  it('rejects a request with an incorrect signature (wrong secret)', async () => {
    const app = makeApp();
    const body = { test: true };
    const wrongSig = crypto
      .createHmac('sha256', 'wrong-secret')
      .update(JSON.stringify(body))
      .digest('hex');

    const res = await request(app)
      .post('/protected')
      .set('X-Lodestar-Signature', wrongSig)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('HMAC_INVALID');
    expect(res.body.error).toMatch(/Invalid signature/);
  });

  it('rejects a request with a completely arbitrary signature', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/protected')
      .set('X-Lodestar-Signature', 'deadbeef1234')
      .send({ foo: 'bar' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('HMAC_INVALID');
  });

  // ── Length-difference boundary ─────────────────────────────────────

  it('rejects when the signature buffer length differs from the expected length', async () => {
    const app = makeApp();
    const body = { boundary: 'test' };
    // HMAC-SHA256 hex is 64 chars; send a 63-char hex string.
    const shortSig = 'a'.repeat(63);

    const res = await request(app)
      .post('/protected')
      .set('X-Lodestar-Signature', shortSig)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('HMAC_INVALID');
  });

  it('rejects when the signature buffer is longer than expected', async () => {
    const app = makeApp();
    const body = { boundary: 'test' };
    const longSig = 'b'.repeat(65);

    const res = await request(app)
      .post('/protected')
      .set('X-Lodestar-Signature', longSig)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('HMAC_INVALID');
  });

  // ── Timing-safe comparison ─────────────────────────────────────────

  it('uses crypto.timingSafeEqual for signature comparison', async () => {
    const app = makeApp();
    const body = { timing: 'safe' };
    const sig = validSignature(body);

    // Reset the spy count after importing
    timingSafeEqualSpy.mockClear();

    await request(app)
      .post('/protected')
      .set('X-Lodestar-Signature', sig)
      .send(body);

    // timingSafeEqual should be called exactly once for the comparison
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);

    const [a, b] = timingSafeEqualSpy.mock.calls[0];
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(Buffer.isBuffer(b)).toBe(true);
    expect(a.length).toBe(b.length); // lengths must match for timingSafeEqual
  });

  it('does not call timingSafeEqual when the signature is missing', async () => {
    const app = makeApp();
    timingSafeEqualSpy.mockClear();

    await request(app).post('/protected').send({});

    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
  });

  it('does not call timingSafeEqual when buffer lengths differ', async () => {
    const app = makeApp();
    timingSafeEqualSpy.mockClear();

    const body = { len: 'test' };
    const res = await request(app)
      .post('/protected')
      .set('X-Lodestar-Signature', 'a'.repeat(32))
      .send(body);

    // Length differs (32 vs 64) — middleware short-circuits before timingSafeEqual
    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });
});
