import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import pkg from '@stellar/stellar-sdk';

const { Keypair, nativeToScVal, Address } = pkg;

const VOTER_KEYPAIR = Keypair.random();
const VOTER_ADDRESS = VOTER_KEYPAIR.publicKey();
const VOTER_SECRET = VOTER_KEYPAIR.secret();
const VALID_CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

// Configure env before importing config/contract/registry so the voter allowlist
// and REPUTATION_TIMEOUT_MS are picked up with deterministic test values.
process.env.CONTRACT_ID = VALID_CONTRACT_ID;
process.env.SERVER_STELLAR_ADDRESS = VOTER_ADDRESS;
process.env.SERVER_STELLAR_SECRET = VOTER_SECRET;
process.env.STELLAR_RPC_URL = 'http://localhost:8000';
process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
process.env.FACILITATOR_URL = 'http://localhost:4020';
process.env.USDC_CONTRACT_ID = VALID_CONTRACT_ID;
process.env.REPUTATION_TIMEOUT_MS = '120';

const mockServer = {
  getAccount: vi.fn(),
  simulateTransaction: vi.fn(),
  sendTransaction: vi.fn(),
  getTransaction: vi.fn(),
};

vi.mock('../src/lib/stellar.js', () => ({
  getStellarServer: () => mockServer,
  getNetworkPassphrase: () => 'Test SDF Network ; September 2015',
  getCurrentLedgerSequence: vi.fn().mockResolvedValue(1000),
}));

vi.mock('../src/lib/logger.js', () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock('../src/middleware/rateLimiter.js', () => ({
  writeRateLimiter: () => (_req, _res, next) => next(),
}));

function makeServiceScVal(reputation = 10) {
  return nativeToScVal({
    id: BigInt(1),
    name: 'Weather Oracle',
    description: 'Forecast service',
    endpoint: 'https://weather.example.com',
    price_usdc: '0.001',
    pay_to: VOTER_ADDRESS,
    category: 'weather',
    provider: Address.fromString(VOTER_ADDRESS),
    reputation: BigInt(reputation),
    active: true,
    registered_at: BigInt(1000),
  });
}

let app;
let contractModule;
let routeMetricsModule;

beforeAll(async () => {
  contractModule = await import('../src/lib/contract.js');
  routeMetricsModule = await import('../src/lib/routeMetrics.js');
  // Bypass Soroban footprint assembly in tests; return a builder whose `.build()`
  // yields the already-built transaction ready to sign.
  contractModule.__setAssembleTransactionForTest((tx) => ({ build: () => tx }));

  const router = (await import('../src/routes/registry.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api', router);
});

beforeEach(() => {
  vi.clearAllMocks();
  routeMetricsModule.resetRouteMetrics();
  contractModule.__resetPendingTransactions();
  mockServer.getAccount.mockResolvedValue({ sequence: '100' });
});

afterEach(async () => {
  await contractModule.drainSubmitQueue();
});

describe('POST /api/reputation/:id — Soroban RPC timeout & no duplicate on-chain writes', () => {
  it('stops cleanly before sendTransaction when simulateTransaction exceeds REPUTATION_TIMEOUT_MS', async () => {
    let resolveDelayedSim;
    const delayedSim = new Promise((resolve) => {
      resolveDelayedSim = resolve;
    });

    // 1st simulateTransaction is `getService(1)` read; 2nd is the write simulation.
    mockServer.simulateTransaction
      .mockResolvedValueOnce({ result: { retval: makeServiceScVal(10) } })
      .mockReturnValueOnce(delayedSim);

    const res = await request(app)
      .post('/api/reputation/1')
      .send({ positive: true, agent: VOTER_ADDRESS });

    expect(res.status).toBe(504);
    expect(res.body.code).toBe('UPSTREAM_TIMEOUT');
    expect(routeMetricsModule.getRouteMetrics().upstreamTimeouts.byLabel.reputation).toBe(1);

    // Even if the slow RPC simulation eventually resolves after the deadline,
    // the aborted signal must prevent sendTransaction from ever being called.
    resolveDelayedSim({ result: { retval: makeServiceScVal(11) } });
    await contractModule.drainSubmitQueue();

    expect(mockServer.sendTransaction).not.toHaveBeenCalled();
  });

  it('returns 504 UPSTREAM_TIMEOUT and never retries sendTransaction when RPC submission hangs', async () => {
    let resolveDelayedSend;
    const delayedSend = new Promise((resolve) => {
      resolveDelayedSend = resolve;
    });

    mockServer.simulateTransaction
      .mockResolvedValueOnce({ result: { retval: makeServiceScVal(10) } })
      .mockResolvedValueOnce({ result: { retval: makeServiceScVal(11) } });
    mockServer.sendTransaction.mockReturnValueOnce(delayedSend);

    const res = await request(app)
      .post('/api/reputation/1')
      .send({ positive: true, agent: VOTER_ADDRESS });

    expect(res.status).toBe(504);
    expect(res.body.code).toBe('UPSTREAM_TIMEOUT');
    expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);

    // Resolving the hung send after timeout must not trigger a retry or second write.
    resolveDelayedSend({ status: 'ERROR', errorResult: 'txBAD_SEQ' });
    await contractModule.drainSubmitQueue();

    expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('stops polling getTransaction after REPUTATION_TIMEOUT_MS without duplicating sendTransaction', async () => {
    mockServer.simulateTransaction
      .mockResolvedValueOnce({ result: { retval: makeServiceScVal(10) } })
      .mockResolvedValueOnce({ result: { retval: makeServiceScVal(11) } });
    mockServer.sendTransaction.mockResolvedValueOnce({
      status: 'PENDING',
      hash: 'tx-hash-slow-confirm',
    });
    mockServer.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' });

    const res = await request(app)
      .post('/api/reputation/1')
      .send({ positive: true, agent: VOTER_ADDRESS });

    expect(res.status).toBe(504);
    expect(res.body.code).toBe('UPSTREAM_TIMEOUT');
    expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);

    // Drain the queue to ensure the polling loop exited promptly on abort.
    await contractModule.drainSubmitQueue();
    expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
    expect(mockServer.getTransaction.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
