import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  default: {
    contract: { id: 'mock', agentsId: 'mock' },
    server: { address: 'mock', secret: 'SDY7R6HC2UK4D4CWWBKZBJTE6FLY5QHGQCK2U6U3R3KASMW5OPWMBDO2' },
    stellar: { network: 'testnet', rpcUrl: 'https://mock', networkPassphrase: 'mock', usdcContractId: 'mock' },
    x402: { facilitatorUrl: 'https://mock', searchPrice: '0.001', weatherPrice: '0.001' },
    braveApiKey: '',
    corsOrigin: ['http://localhost:3000'],
    jsonBodyLimit: '100kb',
    nodeEnv: 'test',
    port: 3001,
    logLevel: 'silent',
  },
}));

import * as contractLib from './contract.js';

const { mapAgent, mapPolicy } = contractLib;

describe('registerServiceOnChain duplicate checks', () => {
  let activeServiceExistsSpy;

  beforeEach(() => {
    activeServiceExistsSpy = vi.spyOn(contractLib.contractHelpers, 'activeServiceExists');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when an active service exists for the same provider and endpoint', async () => {
    const provider = 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ';
    const endpoint = 'https://test.example.com';
    activeServiceExistsSpy.mockResolvedValueOnce(true);

    expect(await contractLib.activeServiceExists(provider, endpoint)).toBe(true);
    expect(activeServiceExistsSpy).toHaveBeenCalledWith(provider, endpoint, expect.any(Function));
  });

  it('returns false when no matching active service exists', async () => {
    activeServiceExistsSpy.mockResolvedValueOnce(false);

    expect(await contractLib.activeServiceExists('GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ', 'https://test.example.com')).toBe(false);
  });

  it('throws when duplicate active service exists during registration', async () => {
    activeServiceExistsSpy.mockResolvedValueOnce(true);

    await expect(
      contractLib.registerServiceOnChain('Service', 'Description', 'https://test.example.com', '0.001', 'test')
    ).rejects.toThrow('Active service with same provider and endpoint already exists');

    expect(activeServiceExistsSpy).toHaveBeenCalled();
  });
});

describe('activeServiceExists pagination', () => {
  it('continues scanning when a page is shorter than the requested page size', async () => {
    const provider = 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ';
    const endpoint = 'https://test.example.com';

    const fetchServices = vi
      .fn()
      .mockResolvedValueOnce([
        { provider: 'GAOTHER', endpoint: 'https://other.example.com' },
      ])
      .mockResolvedValueOnce([
        { provider, endpoint },
      ]);

    await expect(
      contractLib.contractHelpers.activeServiceExists(provider, endpoint, fetchServices)
    ).resolves.toBe(true);

    expect(fetchServices).toHaveBeenNthCalledWith(1, { page: 0, pageSize: 20 });
    expect(fetchServices).toHaveBeenNthCalledWith(2, { page: 1, pageSize: 20 });
  });
});

describe('mapAgent', () => {
  it('should map a basic agent object', () => {
    const raw = {
      address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      name: 'Test Agent',
      description: 'A test agent',
      owner: 'GBV4ZDEPLQTVPQFJRME2BGYL6VQJLTTRIWJHTJNFGXBVF4WY5DJIQK2K',
      score: 100n,
      total_payments: 5n,
      successful_payments: 3n,
      failed_payments: 2n,
      total_volume_stroops: 10000000n,
      registered_at: 1000n,
      last_active: 2000n,
      active: true,
      flagged: false,
      flag_reason: '',
    };

    const result = mapAgent(raw);

    expect(result.address).toBe(raw.address);
    expect(result.name).toBe('Test Agent');
    expect(result.score).toBe(100);
    expect(result.total_payments).toBe(5);
    expect(result.total_volume_stroops).toBe('10000000');
    expect(result.active).toBe(true);
    expect(result.flagged).toBe(false);
  });

  it('should handle zero values', () => {
    const raw = {
      address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      name: 'Zero Agent',
      description: 'All zeros',
      owner: 'GBV4ZDEPLQTVPQFJRME2BGYL6VQJLTTRIWJHTJNFGXBVF4WY5DJIQK2K',
      score: 0n,
      total_payments: 0n,
      successful_payments: 0n,
      failed_payments: 0n,
      total_volume_stroops: 0n,
      registered_at: 0n,
      last_active: 0n,
      active: true,
      flagged: false,
      flag_reason: '',
    };

    const result = mapAgent(raw);

    expect(result.score).toBe(0);
    expect(result.total_payments).toBe(0);
    expect(result.total_volume_stroops).toBe('0');
    expect(result.registered_at).toBe(0);
    expect(result.last_active).toBe(0);
  });

  it('should handle values at Number.MAX_SAFE_INTEGER', () => {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    const raw = {
      address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      name: 'Safe Agent',
      description: 'At max safe integer',
      owner: 'GBV4ZDEPLQTVPQFJRME2BGYL6VQJLTTRIWJHTJNFGXBVF4WY5DJIQK2K',
      score: maxSafe,
      total_payments: maxSafe,
      successful_payments: maxSafe,
      failed_payments: maxSafe,
      total_volume_stroops: maxSafe,
      registered_at: maxSafe,
      last_active: maxSafe,
      active: true,
      flagged: false,
      flag_reason: '',
    };

    const result = mapAgent(raw);

    expect(result.score).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.total_payments).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.total_volume_stroops).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(result.registered_at).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.last_active).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('should handle values exceeding Number.MAX_SAFE_INTEGER', () => {
    const large = BigInt(Number.MAX_SAFE_INTEGER) * 2n;
    const raw = {
      address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      name: 'Large Agent',
      description: 'Exceeding safe integer',
      owner: 'GBV4ZDEPLQTVPQFJRME2BGYL6VQJLTTRIWJHTJNFGXBVF4WY5DJIQK2K',
      score: large,
      total_payments: large,
      successful_payments: large,
      failed_payments: large,
      total_volume_stroops: large,
      registered_at: large,
      last_active: large,
      active: true,
      flagged: false,
      flag_reason: '',
    };

    const result = mapAgent(raw);

    expect(result.total_volume_stroops).toBe(large.toString());
    expect(result.score).toBe(large.toString());
    expect(result.total_payments).toBe(large.toString());
    expect(result.successful_payments).toBe(large.toString());
    expect(result.failed_payments).toBe(large.toString());
    expect(result.registered_at).toBe(large.toString());
    expect(result.last_active).toBe(large.toString());
  });

  it('should handle negative i128 values', () => {
    const raw = {
      address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      name: 'Negative Agent',
      description: 'Negative scores',
      owner: 'GBV4ZDEPLQTVPQFJRME2BGYL6VQJLTTRIWJHTJNFGXBVF4WY5DJIQK2K',
      score: -50n,
      total_payments: 10n,
      successful_payments: 5n,
      failed_payments: 5n,
      total_volume_stroops: 0n,
      registered_at: 0n,
      last_active: 0n,
      active: true,
      flagged: false,
      flag_reason: '',
    };

    const result = mapAgent(raw);

    expect(result.score).toBe(-50);
    expect(result.total_payments).toBe(10);
  });

  it('should handle values at Number.MIN_SAFE_INTEGER', () => {
    const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
    const raw = {
      address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      name: 'Min Safe Agent',
      description: 'At min safe integer',
      owner: 'GBV4ZDEPLQTVPQFJRME2BGYL6VQJLTTRIWJHTJNFGXBVF4WY5DJIQK2K',
      score: minSafe,
      total_payments: 0n,
      successful_payments: 0n,
      failed_payments: 0n,
      total_volume_stroops: 0n,
      registered_at: 0n,
      last_active: 0n,
      active: true,
      flagged: false,
      flag_reason: '',
    };

    const result = mapAgent(raw);

    expect(result.score).toBe(Number.MIN_SAFE_INTEGER);
  });

  it('should handle values below Number.MIN_SAFE_INTEGER as string', () => {
    const belowMin = BigInt(Number.MIN_SAFE_INTEGER) * 2n;
    const raw = {
      address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      name: 'Below Min Agent',
      description: 'Below min safe integer',
      owner: 'GBV4ZDEPLQTVPQFJRME2BGYL6VQJLTTRIWJHTJNFGXBVF4WY5DJIQK2K',
      score: belowMin,
      total_payments: 0n,
      successful_payments: 0n,
      failed_payments: 0n,
      total_volume_stroops: 0n,
      registered_at: 0n,
      last_active: 0n,
      active: true,
      flagged: false,
      flag_reason: '',
    };

    const result = mapAgent(raw);

    expect(result.score).toBe(belowMin.toString());
  });

  it('should handle Address-like objects with toString', () => {
    const raw = {
      address: { toString: () => 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ' },
      name: 'Obj Agent',
      description: 'Address as object',
      owner: { toString: () => 'GBV4ZDEPLQTVPQFJRME2BGYL6VQJLTTRIWJHTJNFGXBVF4WY5DJIQK2K' },
      score: 200n,
      total_payments: 10n,
      successful_payments: 8n,
      failed_payments: 2n,
      total_volume_stroops: 5000000n,
      registered_at: 3000n,
      last_active: 4000n,
      active: true,
      flagged: false,
      flag_reason: '',
    };

    const result = mapAgent(raw);

    expect(result.address).toBe('GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ');
    expect(result.owner).toBe('GBV4ZDEPLQTVPQFJRME2BGYL6VQJLTTRIWJHTJNFGXBVF4WY5DJIQK2K');
  });
});

describe('mapPolicy', () => {
  it('should map a basic policy object', () => {
    const raw = {
      agent_address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      max_per_tx_stroops: 10000000n,
      max_per_day_stroops: 50000000n,
      allowed_categories: ['weather', 'search'],
      min_score_to_earn: 300n,
      daily_spent_stroops: 0n,
      last_reset_ledger: 12345n,
    };

    const result = mapPolicy(raw);

    expect(result.agent_address).toBe(raw.agent_address);
    expect(result.max_per_tx_stroops).toBe('10000000');
    expect(result.max_per_day_stroops).toBe('50000000');
    expect(result.allowed_categories).toEqual(['weather', 'search']);
    expect(result.min_score_to_earn).toBe(300);
    expect(result.daily_spent_stroops).toBe('0');
    expect(result.last_reset_ledger).toBe(12345);
  });

  it('should handle zero values', () => {
    const raw = {
      agent_address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      max_per_tx_stroops: 0n,
      max_per_day_stroops: 0n,
      allowed_categories: [],
      min_score_to_earn: 0n,
      daily_spent_stroops: 0n,
      last_reset_ledger: 0n,
    };

    const result = mapPolicy(raw);

    expect(result.max_per_tx_stroops).toBe('0');
    expect(result.max_per_day_stroops).toBe('0');
    expect(result.allowed_categories).toEqual([]);
    expect(result.min_score_to_earn).toBe(0);
    expect(result.daily_spent_stroops).toBe('0');
    expect(result.last_reset_ledger).toBe(0);
  });

  it('should handle values at Number.MAX_SAFE_INTEGER', () => {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    const raw = {
      agent_address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      max_per_tx_stroops: maxSafe,
      max_per_day_stroops: maxSafe,
      allowed_categories: ['premium'],
      min_score_to_earn: maxSafe,
      daily_spent_stroops: maxSafe,
      last_reset_ledger: maxSafe,
    };

    const result = mapPolicy(raw);

    expect(result.max_per_tx_stroops).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(result.max_per_day_stroops).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(result.min_score_to_earn).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.daily_spent_stroops).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(result.last_reset_ledger).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('should handle values exceeding Number.MAX_SAFE_INTEGER', () => {
    const large = BigInt(Number.MAX_SAFE_INTEGER) * 10n;
    const raw = {
      agent_address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      max_per_tx_stroops: large,
      max_per_day_stroops: large,
      allowed_categories: ['all'],
      min_score_to_earn: large,
      daily_spent_stroops: large,
      last_reset_ledger: large,
    };

    const result = mapPolicy(raw);

    expect(result.max_per_tx_stroops).toBe(large.toString());
    expect(result.max_per_day_stroops).toBe(large.toString());
    expect(result.daily_spent_stroops).toBe(large.toString());
    expect(result.min_score_to_earn).toBe(large.toString());
    expect(result.last_reset_ledger).toBe(large.toString());
  });

  it('should handle negative i128 values', () => {
    const raw = {
      agent_address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      max_per_tx_stroops: 10000000n,
      max_per_day_stroops: 50000000n,
      allowed_categories: ['weather'],
      min_score_to_earn: -100n,
      daily_spent_stroops: 0n,
      last_reset_ledger: 1000n,
    };

    const result = mapPolicy(raw);

    expect(result.min_score_to_earn).toBe(-100);
  });

  it('should handle values at Number.MIN_SAFE_INTEGER', () => {
    const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
    const raw = {
      agent_address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      max_per_tx_stroops: 0n,
      max_per_day_stroops: 0n,
      allowed_categories: [],
      min_score_to_earn: minSafe,
      daily_spent_stroops: 0n,
      last_reset_ledger: 0n,
    };

    const result = mapPolicy(raw);

    expect(result.min_score_to_earn).toBe(Number.MIN_SAFE_INTEGER);
  });

  it('should handle values below Number.MIN_SAFE_INTEGER as string', () => {
    const belowMin = BigInt(Number.MIN_SAFE_INTEGER) * 2n;
    const raw = {
      agent_address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      max_per_tx_stroops: 0n,
      max_per_day_stroops: 0n,
      allowed_categories: [],
      min_score_to_earn: belowMin,
      daily_spent_stroops: 0n,
      last_reset_ledger: belowMin,
    };

    const result = mapPolicy(raw);

    expect(result.min_score_to_earn).toBe(belowMin.toString());
    expect(result.last_reset_ledger).toBe(belowMin.toString());
  });

  it('should handle object-like addresses', () => {
    const raw = {
      agent_address: { toString: () => 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ' },
      max_per_tx_stroops: 10000000n,
      max_per_day_stroops: 50000000n,
      allowed_categories: ['weather'],
      min_score_to_earn: 100n,
      daily_spent_stroops: 2000000n,
      last_reset_ledger: 54321n,
    };

    const result = mapPolicy(raw);

    expect(result.agent_address).toBe('GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ');
  });

  it('should default allowed_categories to empty array when not array', () => {
    const raw = {
      agent_address: 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ',
      max_per_tx_stroops: 10000000n,
      max_per_day_stroops: 50000000n,
      allowed_categories: null,
      min_score_to_earn: 100n,
      daily_spent_stroops: 0n,
      last_reset_ledger: 0n,
    };

    const result = mapPolicy(raw);

    expect(result.allowed_categories).toEqual([]);
  });
});
