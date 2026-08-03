/**
 * Issue #531 — client disconnect during /api/demo-run polling.
 *
 * This test lives OUTSIDE the repo's existing suites on purpose: it covers
 * the scenario that the current tests structurally cannot see (disconnect
 * DURING the real polling phase). The existing suite mocks
 * waitForActivityTxHash to resolve instantly, so the handler completes
 * before the 'close' event fires and the abort never matters.
 *
 * Here we run the REAL waitForActivityTxHash (not mocked) and destroy the
 * client socket mid-poll, exactly like a real browser tab being closed.
 *
 * Expected behavior with the fix:
 *   - normal request  -> 200, poll runs (not aborted)
 *   - disconnect mid-poll -> poll cancels early (no full budget waste)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import demoRouter from '../src/routes/demo.js';
import * as contract from '../src/lib/contract.js';

vi.mock('../src/lib/contract.js', () => ({
  getService: vi.fn(),
}));

vi.mock('../src/routes/demoValidate.js', () => ({
  validateDemoEndpoint: vi.fn().mockReturnValue('http://localhost:9999/demo'),
}));

vi.mock('../src/routes/services.js', () => ({
  recordActivity: vi.fn(),
  getActivityFeed: vi.fn(() => []),
}));

vi.mock('@x402/core/client', () => ({
  x402Client: vi.fn().mockImplementation(() => ({
    register: vi.fn().mockReturnThis(),
  })),
  x402HTTPClient: vi.fn().mockImplementation(() => ({
    fetchWithTx: vi.fn().mockResolvedValue({
      response: {
        ok: true,
        status: 200,
        json: async () => ({ weather: 'sunny' }),
        headers: { get: () => null },
      },
      txHash: '',
    }),
  })),
}));

vi.mock('@x402/stellar', () => ({
  createEd25519Signer: vi.fn(),
}));

vi.mock('@x402/stellar/exact/client', () => ({
  ExactStellarScheme: vi.fn(),
}));

import * as services from '../src/routes/services.js';

// buildHttpClient() overrides fetchWithTx with the real implementation, which
// calls global fetch(). Stub fetch so the route's "payment" succeeds without
// touching the network: a 200 response means "no payment required" and the
// flow proceeds straight into the polling phase.
const fetchMock = vi.fn(async () =>
  new Response(JSON.stringify({ weather: 'sunny' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }),
);
vi.stubGlobal('fetch', fetchMock);

// ── helpers ─────────────────────────────────────────────────────────────────

function makeSleepRecorder() {
  const delays = [];
  const sleep = vi.fn(async (ms) => {
    delays.push(ms);
  });
  return { sleep, delays };
}

const defaultOptions = { maxWaitMs: 8000, initialDelayMs: 250, maxDelayMs: 2000 };

async function startServer(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  return server;
}

function sendDemoRun(port, onResponse) {
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/api/demo-run',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    },
    (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => onResponse({ status: res.statusCode, body: data }));
    },
  );
  req.on('error', () => {}); // ECONNRESET on destroy is expected
  req.end(JSON.stringify({ serviceId: 1, category: 'weather' }));
  return req;
}

// ── unit tests: abort signal in waitForActivityTxHash ────────────────────────

import { waitForActivityTxHash } from '../src/lib/waitForActivityTxHash.js';

describe('waitForActivityTxHash — abort signal (issue #531)', () => {
  it('breaks immediately when the signal is already aborted', async () => {
    const { sleep, delays } = makeSleepRecorder();
    const controller = new AbortController();
    controller.abort();
    const getFeed = vi.fn(() => [{ txHash: 'abc123' }]);

    const result = await waitForActivityTxHash(
      getFeed,
      0,
      defaultOptions,
      undefined,
      sleep,
      controller.signal,
    );

    expect(result).toBe('');
    expect(getFeed).not.toHaveBeenCalled();
    expect(delays).toEqual([]);
  });

  it('stops polling once the signal aborts mid-wait', async () => {
    const { sleep, delays } = makeSleepRecorder();
    const controller = new AbortController();
    const getFeed = vi.fn(() => []);

    // Simulate a disconnect arriving during the first sleep delay.
    sleep.mockImplementationOnce(async (ms) => {
      delays.push(ms);
      controller.abort();
    });

    const result = await waitForActivityTxHash(
      getFeed,
      0,
      defaultOptions,
      undefined,
      sleep,
      controller.signal,
    );

    expect(result).toBe('');
    expect(getFeed).toHaveBeenCalledTimes(1);
    expect(delays.length).toBe(1); // one delay, then the loop stops
  });
});

// ── integration tests: real HTTP socket, real polling ───────────────────────

describe('POST /api/demo-run — client disconnect during real polling (issue #531)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.getActivityFeed.mockReturnValue([]);
    services.recordActivity.mockClear();
  });

  it('completes a normal request without aborting the poll', async () => {
    contract.getService.mockResolvedValue({ name: 'Test Service', endpoint: 'test', price_usdc: '1' });
    const app = express();
    app.use(express.json());
    app.use('/api', demoRouter);
    const server = await startServer(app);

    const started = Date.now();
    const result = await new Promise((resolve) => {
      sendDemoRun(server.address().port, resolve);
    });
    const elapsed = Date.now() - started;

    server.close();
    expect(result.status).toBe(200);
    expect(elapsed).toBeGreaterThan(200); // the poll actually ran
  }, 15_000); // real polling runs the full 8s budget by design

  it('cancels the poll when the client disconnects mid-request', async () => {
    contract.getService.mockResolvedValue({ name: 'Test Service', endpoint: 'test', price_usdc: '1' });
    const app = express();
    app.use(express.json());
    app.use('/api', demoRouter);
    const server = await startServer(app);

    const started = Date.now();
    // Real client that pays and then closes the tab ~200ms in.
    await new Promise((resolve) => {
      const req = sendDemoRun(server.address().port, () => resolve());
      setTimeout(() => req.destroy(), 200);
      setTimeout(resolve, 400); // give the handler time to react
    });
    const elapsed = Date.now() - started;

    server.close();
    // The poll budget is 8000ms; after a disconnect it must stop well before.
    expect(elapsed).toBeLessThan(2000);
    expect(services.recordActivity).toHaveBeenCalled();
  });
});
