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
import { boost, validateBoostConfig } from './boost-scores.js';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEMO_MODE = 'true';
  process.env.AGENTS_CONTRACT_ID = 'CTEST';
  process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
});

const makeAgent = (overrides) => ({
  name: 'test-agent',
  address: 'GTESTADDRESS',
  score: 0,
  registered_at: Date.now(),
  ...overrides,
});

describe('boost() dry-run', () => {
  it('does not call recordPaymentOnChain', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', score: 100 }),
      makeAgent({ name: 'agent-2', score: 500 }),
    ]);

    await boost({ dryRun: true, targets: [110, 600] });

    expect(recordPaymentOnChain).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith({ name: 'agent-1', target: 110 }, 'boosted');
    expect(logger.info).toHaveBeenCalledWith({ name: 'agent-2', target: 600 }, 'boosted');
  });

  it('skips agents already at target score', async () => {
    listAgents.mockResolvedValue([makeAgent({ name: 'agent-1', score: 110 })]);

    await boost({ dryRun: true, targets: [110] });

    expect(recordPaymentOnChain).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith({ name: 'agent-1', target: 110 }, 'boosted');
  });
});

describe('boost() live mode', () => {
  it('calls recordPaymentOnChain with the current signature', async () => {
    listAgents.mockResolvedValue([makeAgent({ name: 'agent-1', score: 100 })]);

    await boost({ dryRun: false, targets: [110], amount: 10_000n });

    expect(recordPaymentOnChain).toHaveBeenCalledTimes(1);
    expect(recordPaymentOnChain).toHaveBeenCalledWith('GTESTADDRESS', 1, 10_000n, true);
  });
});

describe('boost configuration', () => {
  it('guards mainnet configuration', () => {
    expect(() => validateBoostConfig({
      DEMO_MODE: 'true',
      AGENTS_CONTRACT_ID: 'CMAIN',
      STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
    })).toThrow('testnet');
  });
});
