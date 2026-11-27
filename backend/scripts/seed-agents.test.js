import { vi, describe, it, expect, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgentCount: vi.fn(),
  getAgent: vi.fn(),
  registerAgentOnChain: vi.fn(),
  recordPaymentOnChain: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../src/lib/contract.js', () => ({
  getAgentCount: mocks.getAgentCount,
  getAgent: mocks.getAgent,
  registerAgentOnChain: mocks.registerAgentOnChain,
  recordPaymentOnChain: mocks.recordPaymentOnChain,
}));

vi.mock('../src/lib/logger.js', () => ({ default: mocks.logger }));
vi.mock('../src/config.js', () => ({ default: { server: { address: 'GSERVER' } } }));

import { AGENTS, seed, validateDemoSeedingConfig } from './seed-agents.js';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENTS_CONTRACT_ID = 'CTEST';
  process.env.STELLAR_NETWORK = 'testnet';
  process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
  mocks.getAgentCount.mockResolvedValue(100);
  mocks.getAgent.mockResolvedValue({ score: 1000 });
  mocks.registerAgentOnChain.mockResolvedValue(true);
  mocks.recordPaymentOnChain.mockResolvedValue(true);
});

describe('demo agent seeding', () => {
  it('creates a deterministic fixture of 100 agents', () => {
    expect(AGENTS).toHaveLength(100);
    expect(AGENTS[0].name).toBe('NewAgent');
    expect(AGENTS[99].name).toBe('DemoAgent100');
  });

  it('guards mainnet configuration', () => {
    expect(() => validateDemoSeedingConfig({
      AGENTS_CONTRACT_ID: 'CMAIN',
      STELLAR_NETWORK: 'mainnet',
      STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
    })).toThrow('mainnet');
  });

  it('is idempotent when every agent is already seeded', async () => {
    mocks.getAgent.mockImplementation(async (address) =>
      address === 'GSERVER' ? { score: 100 } : { score: 1000 }
    );

    await seed();

    expect(mocks.registerAgentOnChain).not.toHaveBeenCalled();
    expect(mocks.recordPaymentOnChain).not.toHaveBeenCalled();
  });

  it('completes only the missing payments on a partial rerun', async () => {
    mocks.getAgent.mockImplementation(async (address) => {
      if (address === 'GSERVER') return { score: 100 };
      if (address === AGENTS[0].keypair.publicKey()) return { score: 100 };
      return { score: 1000 };
    });

    await seed();

    expect(mocks.registerAgentOnChain).not.toHaveBeenCalled();
    expect(mocks.recordPaymentOnChain).toHaveBeenCalledTimes(1);
  });

  it('seeds the deterministic fixtures from a clean environment', async () => {
    mocks.getAgent.mockImplementation(async (address) =>
      address === 'GSERVER' ? { score: 100 } : null
    );

    await seed();

    expect(mocks.registerAgentOnChain).toHaveBeenCalledTimes(100);
  });
});
