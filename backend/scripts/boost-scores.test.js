import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../src/lib/contract.js', () => ({
  listAgents: vi.fn(),
  recordPaymentOnChain: vi.fn(),
}));

vi.mock('../src/lib/logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { listAgents, recordPaymentOnChain } from '../src/lib/contract.js';
import logger from '../src/lib/logger.js';
import { boost } from './boost-scores.js';

beforeEach(() => {
  vi.clearAllMocks();
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

    // agent-1: (110-100)/10 = 1 payment needed
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent-1', payments: 1 }),
      '[dry-run] Would submit on-chain payments',
    );

    // agent-2: (600-500)/10 = 10 payments needed
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'agent-2', payments: 10 }),
      '[dry-run] Would submit on-chain payments',
    );

    expect(logger.info).toHaveBeenCalledWith('Dry-run complete — no transactions submitted');
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
  it('calls recordPaymentOnChain with correct 4-arg signature', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', score: 100 }),
    ]);

    await boost({ dryRun: false, targets: [110], amount: 10_000n, serviceId: 42n });

    // (110-100)/10 = 1 payment
    expect(recordPaymentOnChain).toHaveBeenCalledTimes(1);
    expect(recordPaymentOnChain).toHaveBeenCalledWith('GTESTADDRESS', 42n, 10_000n, true);

    expect(logger.info).toHaveBeenCalledWith({ name: 'agent-1', targetScore: 110 }, 'Done');
  });

  it('throws when serviceId is missing', async () => {
    listAgents.mockResolvedValue([
      makeAgent({ name: 'agent-1', score: 100 }),
    ]);

    await expect(
      boost({ dryRun: false, targets: [110], amount: 10_000n }),
    ).rejects.toThrow('serviceId is required for live boost mode');
  });
});
