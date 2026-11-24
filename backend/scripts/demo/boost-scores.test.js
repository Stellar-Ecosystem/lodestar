import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/lib/contract.js', () => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  recordPaymentOnChain: vi.fn(),
}));

vi.mock('../../src/lib/logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { listAgents, getAgent, recordPaymentOnChain } from '../../src/lib/contract.js';
import logger from '../../src/lib/logger.js';
import { boost } from './boost-scores.js';

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
  it('logs planned payments without calling recordPaymentOnChain', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', score: 100 }),
      makeAgent({ name: 'agent-2', score: 500 }),
    ]);

    await boost({ dryRun: true, targets: [110, 600] });

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

    await boost({ dryRun: true, targets: [110] });

    expect(recordPaymentOnChain).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { name: 'agent-1', score: 110 },
      'Score already at target — skipping',
    );
  });
});

describe('boost() live mode', () => {
  it('calls recordPaymentOnChain for each payment with the correct arguments', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', score: 100 }),
    ]);
    getAgent.mockResolvedValue(makeAgent({ name: 'agent-1', score: 100 }));

    await boost({ dryRun: false, targets: [110], amount: 10_000n });

    // (110-100)/10 = 1 payment
    expect(recordPaymentOnChain).toHaveBeenCalledTimes(1);
    // serviceId 1 (demo weather service), amount, success=true
    expect(recordPaymentOnChain).toHaveBeenCalledWith('GTESTADDRESS', 1, 10_000n, true);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent-1', targetScore: 110 }),
      'Done',
    );
  });

  it('skips payments already settled on a re-run', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', score: 100 }),
    ]);
    // Live score is already at target — previous run settled all payments.
    getAgent.mockResolvedValue(makeAgent({ name: 'agent-1', score: 110 }));

    await boost({ dryRun: false, targets: [110], amount: 10_000n });

    expect(recordPaymentOnChain).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { name: 'agent-1', score: 110 },
      'Score already at target — skipping',
    );
  });

  it('issues only the remaining payments after a partial re-run', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', score: 100 }),
    ]);
    // 3 of 10 payments already settled on-chain.
    getAgent.mockResolvedValue(makeAgent({ name: 'agent-1', score: 130 }));

    await boost({ dryRun: false, targets: [200], amount: 10_000n });

    // (200-130)/10 = 7 payments remaining
    expect(recordPaymentOnChain).toHaveBeenCalledTimes(7);
  });
});
