import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/lib/contract.js', () => ({
  listAgents: vi.fn(),
  recordPaymentOnChain: vi.fn(),
}));

vi.mock('../../src/lib/logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { listAgents, recordPaymentOnChain } from '../../src/lib/contract.js';
import logger from '../../src/lib/logger.js';
import {
  boost,
  validateBoostConfig,
  TESTNET_PASSPHRASE,
  MAINNET_PASSPHRASE,
  MAX_SEED_AGENTS,
} from './boost-scores.js';

const VALID_CONTRACT_ID = `C${'A'.repeat(55)}`;
const VALID_AGENTS_CONTRACT_ID = `C${'B'.repeat(55)}`;
const VALID_USDC_CONTRACT_ID = `C${'C'.repeat(55)}`;
const VALID_SERVER_ADDRESS = `G${'A'.repeat(55)}`;
const VALID_PAYMENT_ADDRESS = `G${'B'.repeat(55)}`;
const VALID_SERVER_SECRET = `S${'A'.repeat(55)}`;

function makeValidEnv(overrides = {}) {
  return {
    DEMO_MODE: 'true',
    STELLAR_NETWORK: 'testnet',
    STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
    STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
    CONTRACT_ID: VALID_CONTRACT_ID,
    AGENTS_CONTRACT_ID: VALID_AGENTS_CONTRACT_ID,
    USDC_CONTRACT_ID: VALID_USDC_CONTRACT_ID,
    SERVER_STELLAR_ADDRESS: VALID_SERVER_ADDRESS,
    SERVER_STELLAR_SECRET: VALID_SERVER_SECRET,
    PAYMENT_ADDRESS: VALID_PAYMENT_ADDRESS,
    FACILITATOR_URL: 'https://facilitator.testnet.example.com',
    ...overrides,
  };
}

const makeAgent = (overrides) => ({
  name: 'test-agent',
  address: VALID_SERVER_ADDRESS,
  score: 0,
  registered_at: Date.now(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateBoostConfig()', () => {
  it('accepts a valid testnet configuration for seeding up to 100 agents', () => {
    const result = validateBoostConfig(makeValidEnv(), {
      dryRun: false,
      knownContractIds: [],
      limit: MAX_SEED_AGENTS,
      targets: Array.from({ length: MAX_SEED_AGENTS }, () => 200),
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects missing DEMO_MODE and mainnet network settings', () => {
    const result = validateBoostConfig(
      makeValidEnv({
        DEMO_MODE: 'false',
        STELLAR_NETWORK: 'mainnet',
        STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
        STELLAR_RPC_URL: 'https://horizon.stellar.org',
      }),
      { knownContractIds: [] },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('DEMO_MODE'),
        expect.stringContaining('STELLAR_NETWORK'),
        expect.stringContaining('STELLAR_NETWORK_PASSPHRASE'),
        expect.stringContaining('STELLAR_RPC_URL'),
      ]),
    );
  });

  it('rejects invalid address, token, and service settings', () => {
    const result = validateBoostConfig(
      makeValidEnv({
        CONTRACT_ID: 'not-a-contract',
        AGENTS_CONTRACT_ID: 'bad-agents-id',
        USDC_CONTRACT_ID: 'bad-usdc-id',
        SERVER_STELLAR_ADDRESS: 'bad-address',
        PAYMENT_ADDRESS: 'bad-payment-address',
        FACILITATOR_URL: 'not-a-url',
      }),
      { knownContractIds: [] },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('CONTRACT_ID'),
        expect.stringContaining('AGENTS_CONTRACT_ID'),
        expect.stringContaining('USDC_CONTRACT_ID'),
        expect.stringContaining('SERVER_STELLAR_ADDRESS'),
        expect.stringContaining('PAYMENT_ADDRESS'),
        expect.stringContaining('FACILITATOR_URL'),
      ]),
    );
  });

  it('rejects known non-demo deployment contract IDs', () => {
    const result = validateBoostConfig(makeValidEnv(), {
      knownContractIds: [VALID_AGENTS_CONTRACT_ID],
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('AGENTS_CONTRACT_ID matches a known non-demo deployment');
  });

  it('rejects invalid secret in live mode without revealing the secret value', () => {
    const leakedSecret = 'S_TOP_SECRET_VALUE_DO_NOT_LEAK_12345';
    const result = validateBoostConfig(
      makeValidEnv({ SERVER_STELLAR_SECRET: leakedSecret }),
      { dryRun: false, knownContractIds: [] },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('SERVER_STELLAR_SECRET must be a valid Stellar secret key (S...)');
    expect(JSON.stringify(result.errors)).not.toContain(leakedSecret);
  });

  it('rejects limits above 100 agents', () => {
    const result = validateBoostConfig(makeValidEnv(), {
      knownContractIds: [],
      limit: 101,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('limit must be an integer between 1 and 100');
  });
});

describe('boost() validation guard', () => {
  it('stops before signing and never leaks secrets when configuration is invalid', async () => {
    const badSecret = 'S_INVALID_SECRET_VALUE_99999';

    await expect(
      boost({
        dryRun: false,
        env: makeValidEnv({ SERVER_STELLAR_SECRET: badSecret }),
        knownContractIds: [],
      }),
    ).rejects.toThrow('Invalid boost-scores configuration');

    expect(listAgents).not.toHaveBeenCalled();
    expect(recordPaymentOnChain).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(badSecret);
  });
});

describe('boost() dry-run', () => {
  it('logs planned payments without calling recordPaymentOnChain', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', score: 100 }),
      makeAgent({ name: 'agent-2', score: 500 }),
    ]);

    await boost({
      dryRun: true,
      targets: [110, 600],
      env: makeValidEnv({ SERVER_STELLAR_SECRET: '' }),
      knownContractIds: [],
    });

    expect(recordPaymentOnChain).not.toHaveBeenCalled();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent-1', payments: 1 }),
      'Building score…',
    );

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent-2', payments: 10 }),
      'Building score…',
    );

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
      'Score boost complete',
    );
  });

  it('skips agents already at target score', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', score: 110 }),
    ]);

    await boost({
      dryRun: true,
      targets: [110],
      env: makeValidEnv(),
      knownContractIds: [],
    });

    expect(recordPaymentOnChain).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { name: 'agent-1', score: 110 },
      'Score already at target — skipping',
    );
  });
});

describe('boost() live mode', () => {
  it('calls recordPaymentOnChain for each payment', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', score: 100 }),
    ]);

    await boost({
      dryRun: false,
      targets: [110],
      amount: 10_000n,
      env: makeValidEnv(),
      knownContractIds: [],
    });

    // (110-100)/10 = 1 payment
    expect(recordPaymentOnChain).toHaveBeenCalledTimes(1);
    expect(recordPaymentOnChain).toHaveBeenCalledWith(VALID_SERVER_ADDRESS, 10_000n, true);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent-1', targetScore: 110 }),
      'Done',
    );
  });

  it('deterministically seeds 100 agents on testnet and is idempotent on re-run', async () => {
    const agents = Array.from({ length: MAX_SEED_AGENTS }, (_, idx) => {
      const suffix = String(idx).padStart(3, '0');
      return makeAgent({
        name: `agent-${suffix}`,
        address: `G${'A'.repeat(52)}${suffix}`,
        score: 100,
        registered_at: 1_700_000_000 + Math.floor(idx / 2),
      });
    });
    const targets = Array.from({ length: MAX_SEED_AGENTS }, () => 120);

    // First run: each of the 100 agents needs (120 - 100) / 10 = 2 payments
    listAgents.mockResolvedValueOnce([...agents].reverse());
    const firstRun = await boost({
      dryRun: false,
      targets,
      amount: 10_000n,
      env: makeValidEnv(),
      knownContractIds: [],
    });

    expect(listAgents).toHaveBeenCalledWith(MAX_SEED_AGENTS);
    expect(recordPaymentOnChain).toHaveBeenCalledTimes(200);
    expect(firstRun).toMatchObject({
      dryRun: false,
      network: 'testnet',
      totalAgents: MAX_SEED_AGENTS,
      processedCount: MAX_SEED_AGENTS,
      boostedCount: MAX_SEED_AGENTS,
      skippedCount: 0,
      totalPayments: 200,
    });
    expect(firstRun.results).toHaveLength(MAX_SEED_AGENTS);
    expect(firstRun.results[0]).toMatchObject({
      name: 'agent-000',
      previousScore: 100,
      targetScore: 120,
      expectedScore: 120,
      payments: 2,
      status: 'boosted',
    });

    // Second run (idempotent): all 100 agents already at target score 120
    vi.clearAllMocks();
    listAgents.mockResolvedValueOnce(
      agents.map((a) => ({ ...a, score: 120 })),
    );
    const secondRun = await boost({
      dryRun: false,
      targets,
      amount: 10_000n,
      env: makeValidEnv(),
      knownContractIds: [],
    });

    expect(recordPaymentOnChain).not.toHaveBeenCalled();
    expect(secondRun).toMatchObject({
      dryRun: false,
      network: 'testnet',
      totalAgents: MAX_SEED_AGENTS,
      processedCount: MAX_SEED_AGENTS,
      boostedCount: 0,
      skippedCount: MAX_SEED_AGENTS,
      totalPayments: 0,
    });
    expect(secondRun.results.every((r) => r.status === 'skipped' && r.payments === 0)).toBe(true);
  });

  it('deterministically rejects mainnet configuration before reading or signing', async () => {
    await expect(
      boost({
        dryRun: false,
        targets: [110],
        env: makeValidEnv({
          STELLAR_NETWORK: 'mainnet',
          STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
          STELLAR_RPC_URL: 'https://horizon.stellar.org',
        }),
        knownContractIds: [],
      }),
    ).rejects.toThrow('Invalid boost-scores configuration');

    expect(listAgents).not.toHaveBeenCalled();
    expect(recordPaymentOnChain).not.toHaveBeenCalled();
  });
});
