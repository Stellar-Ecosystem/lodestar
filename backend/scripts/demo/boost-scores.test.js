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
import { boost, MAINNET_PASSPHRASE, redactReference } from './boost-scores.js';

const TEST_ENV = {
  DEMO_MODE: 'true',
  AGENTS_CONTRACT_ID: 'CTESTCONTRACT1234567890ABCD',
  STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
};

beforeEach(() => {
  vi.clearAllMocks();
});

const makeAgent = (overrides) => ({
  name: 'test-agent',
  address: 'GTESTADDRESS1234567890WXYZ',
  score: 100,
  registered_at: Date.now(),
  ...overrides,
});

describe('redactReference()', () => {
  it('redacts middle characters of long references', () => {
    expect(redactReference('GTESTADDRESS1234567890WXYZ')).toBe('GTES...WXYZ');
    expect(redactReference('CTESTCONTRACT1234567890ABCD')).toBe('CTES...ABCD');
  });

  it('masks short references and returns null for empty values', () => {
    expect(redactReference('short')).toBe('***');
    expect(redactReference('')).toBeNull();
    expect(redactReference(null)).toBeNull();
  });
});

describe('boost() configuration guards', () => {
  it('logs redacted contractRef and rejects mainnet configuration without calling contract methods', async () => {
    const result = await boost({
      dryRun: false,
      runId: 'run-mainnet-1',
      env: {
        ...TEST_ENV,
        STELLAR_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
      },
      knownIds: [],
    });

    expect(result).toEqual({
      ok: false,
      runId: 'run-mainnet-1',
      dryRun: false,
      contractRef: 'CTES...ABCD',
      reason: 'mainnet_passphrase',
      outcome: 'rejected',
    });
    expect(listAgents).not.toHaveBeenCalled();
    expect(recordPaymentOnChain).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-mainnet-1',
        event: 'boost_scores.config_rejected',
        reason: 'mainnet_passphrase',
        networkType: 'mainnet',
        contractRef: 'CTES...ABCD',
      }),
      expect.any(String)
    );
  });

  it('rejects when DEMO_MODE is not enabled', async () => {
    const result = await boost({
      dryRun: true,
      runId: 'run-nodemo-1',
      env: { ...TEST_ENV, DEMO_MODE: 'false' },
      knownIds: [],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('demo_mode_disabled');
    expect(listAgents).not.toHaveBeenCalled();
  });

  it('rejects known non-demo deployment contract IDs', async () => {
    const result = await boost({
      dryRun: false,
      runId: 'run-known-1',
      env: TEST_ENV,
      knownIds: [TEST_ENV.AGENTS_CONTRACT_ID],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('known_deployment_contract');
    expect(listAgents).not.toHaveBeenCalled();
  });
});

describe('boost() dry-run', () => {
  it('traces discovery to dry-run completion with redacted references and no on-chain writes', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', address: 'GAGENTONE1111111111111111', score: 100, registered_at: 1 }),
      makeAgent({ name: 'agent-2', address: 'GAGENTTWO2222222222222222', score: 500, registered_at: 2 }),
    ]);

    const result = await boost({
      dryRun: true,
      targets: [110, 600],
      runId: 'run-dry-1',
      env: TEST_ENV,
      knownIds: [],
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('dry_run_complete');
    expect(result.totalPaymentsPlanned).toBe(11);
    expect(result.totalPaymentsSubmitted).toBe(0);
    expect(recordPaymentOnChain).not.toHaveBeenCalled();

    const infoEvents = logger.info.mock.calls.map(([fields]) => fields);
    expect(infoEvents.every((f) => f.runId === 'run-dry-1')).toBe(true);
    expect(infoEvents.map((f) => f.event)).toEqual([
      'boost_scores.started',
      'boost_scores.discovered',
      'boost_scores.agent_planned',
      'boost_scores.agent_result',
      'boost_scores.agent_planned',
      'boost_scores.agent_result',
      'boost_scores.completed',
    ]);

    const serialized = JSON.stringify(infoEvents);
    expect(serialized).not.toContain('GAGENTONE1111111111111111');
    expect(serialized).not.toContain('GAGENTTWO2222222222222222');
    expect(serialized).not.toContain(TEST_ENV.AGENTS_CONTRACT_ID);
  });

  it('skips agents already at target score', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', score: 110 }),
    ]);

    const result = await boost({
      dryRun: true,
      targets: [110],
      runId: 'run-skip-1',
      env: TEST_ENV,
      knownIds: [],
    });

    expect(result.ok).toBe(true);
    expect(result.skippedCount).toBe(1);
    expect(result.updatedCount).toBe(0);
    expect(recordPaymentOnChain).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-skip-1',
        event: 'boost_scores.agent_skipped',
        name: 'agent-1',
        currentScore: 110,
        targetScore: 110,
        outcome: 'skipped_at_target',
      }),
      'Score already at target — skipping'
    );
  });
});

describe('boost() live mode and partial seed rerun', () => {
  it('traces one live run from discovery to verified result with redacted payment reference', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', address: 'GAGENTLIVE1234567890LIVE', score: 100, registered_at: 1 }),
    ]);
    recordPaymentOnChain.mockResolvedValue({ hash: 'txhash_abcdef1234567890_secret' });

    const result = await boost({
      dryRun: false,
      targets: [110],
      amount: 10_000n,
      runId: 'run-live-1',
      env: TEST_ENV,
      knownIds: [],
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('verified');
    expect(result.totalPaymentsSubmitted).toBe(1);
    expect(recordPaymentOnChain).toHaveBeenCalledTimes(1);
    expect(recordPaymentOnChain).toHaveBeenCalledWith('GAGENTLIVE1234567890LIVE', 10_000n, true);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-live-1',
        event: 'boost_scores.agent_result',
        name: 'agent-1',
        agentRef: 'GAGE...LIVE',
        contractRef: 'CTES...ABCD',
        paymentRef: 'txha...cret',
        targetScore: 110,
        verifiedScore: 110,
        paymentsSubmitted: 1,
        outcome: 'verified',
      }),
      'Agent score boosted'
    );

    const serialized = JSON.stringify(logger.info.mock.calls);
    expect(serialized).not.toContain('txhash_abcdef1234567890_secret');
    expect(serialized).not.toContain('GAGENTLIVE1234567890LIVE');
  });

  it('logs partialRerun when some agents are already seeded and others need remaining payments', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', address: 'GAGENTONE1111111111111111', score: 110, registered_at: 1 }),
      makeAgent({ name: 'agent-2', address: 'GAGENTTWO2222222222222222', score: 580, registered_at: 2 }),
    ]);
    recordPaymentOnChain.mockResolvedValue(true);

    const result = await boost({
      dryRun: false,
      targets: [110, 600],
      amount: 10_000n,
      runId: 'run-partial-1',
      env: TEST_ENV,
      knownIds: [],
    });

    expect(result.ok).toBe(true);
    expect(result.partialRerun).toBe(true);
    expect(result.skippedCount).toBe(1);
    expect(result.updatedCount).toBe(1);
    expect(result.totalPaymentsSubmitted).toBe(2);
    expect(recordPaymentOnChain).toHaveBeenCalledTimes(2);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-partial-1',
        event: 'boost_scores.completed',
        skippedCount: 1,
        updatedCount: 1,
        totalPaymentsSubmitted: 2,
        partialRerun: true,
        outcome: 'verified',
      }),
      'Demo score seeding run complete'
    );
  });

  it('logs structured failure outcome when payment submission throws', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', score: 100 }),
    ]);
    recordPaymentOnChain.mockRejectedValue(new Error('rpc timeout'));

    const result = await boost({
      dryRun: false,
      targets: [110],
      runId: 'run-fail-1',
      env: TEST_ENV,
      knownIds: [],
    });

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-fail-1',
        event: 'boost_scores.failed',
        contractRef: 'CTES...ABCD',
        outcome: 'failed',
      }),
      'boost-scores failed'
    );
  });
});
