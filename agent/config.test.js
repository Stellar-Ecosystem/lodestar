import { describe, it, expect } from 'vitest';
import {
  loadAgentConfig,
  ConfigError,
  TESTNET_PASSPHRASE,
  MAINNET_PASSPHRASE,
} from './config.js';

const VALID_CONTRACT_ID = 'C' + 'A'.repeat(55);

function baseEnv(overrides = {}) {
  return {
    AGENT_STELLAR_SECRET: 'SENTINEL_SECRET_VALUE',
    STELLAR_RPC_URL: 'https://rpc.example.com',
    LODESTAR_API_URL: 'http://localhost:3001',
    ...overrides,
  };
}

describe('loadAgentConfig — defaults', () => {
  it('defaults to the testnet network and passphrase', () => {
    const cfg = loadAgentConfig(baseEnv());
    expect(cfg.network).toBe('testnet');
    expect(cfg.networkPassphrase).toBe(TESTNET_PASSPHRASE);
  });

  it('uses the mainnet passphrase when STELLAR_NETWORK=mainnet', () => {
    const cfg = loadAgentConfig(baseEnv({ STELLAR_NETWORK: 'mainnet' }));
    expect(cfg.network).toBe('mainnet');
    expect(cfg.networkPassphrase).toBe(MAINNET_PASSPHRASE);
  });

  it('applies documented defaults for optional settings', () => {
    const cfg = loadAgentConfig(baseEnv());
    expect(cfg.maxPerTx).toBe('0.001');
    expect(cfg.maxPerDay).toBe('1.00');
    expect(cfg.allowedCategories).toEqual(['weather', 'search']);
    expect(cfg.minServiceReputation).toBe(0);
    expect(cfg.maxServiceRetries).toBe(3);
    expect(cfg.agentsContractId).toBeUndefined();
    expect(cfg.usdcContractId).toBeUndefined();
  });
});

describe('loadAgentConfig — network passphrase boundary (LDS-2026-191)', () => {
  it('honours an explicit non-empty passphrase', () => {
    const cfg = loadAgentConfig(baseEnv({ STELLAR_NETWORK_PASSPHRASE: 'Custom Net ; 2026' }));
    expect(cfg.networkPassphrase).toBe('Custom Net ; 2026');
  });

  it('rejects a set-but-empty passphrase instead of silently defaulting', () => {
    expect(() => loadAgentConfig(baseEnv({ STELLAR_NETWORK_PASSPHRASE: '   ' }))).toThrow(ConfigError);
    expect(() => loadAgentConfig(baseEnv({ STELLAR_NETWORK_PASSPHRASE: '' }))).toThrow(
      /STELLAR_NETWORK_PASSPHRASE is set but empty/
    );
  });

  it('rejects an unknown network', () => {
    expect(() => loadAgentConfig(baseEnv({ STELLAR_NETWORK: 'futurenet' }))).toThrow(
      /STELLAR_NETWORK must be "testnet" or "mainnet"/
    );
  });
});

describe('loadAgentConfig — contract ID boundary (LDS-2026-191)', () => {
  it('accepts a well-formed contract ID', () => {
    const cfg = loadAgentConfig(baseEnv({ AGENTS_CONTRACT_ID: VALID_CONTRACT_ID }));
    expect(cfg.agentsContractId).toBe(VALID_CONTRACT_ID);
  });

  it('rejects a set-but-empty contract ID', () => {
    expect(() => loadAgentConfig(baseEnv({ AGENTS_CONTRACT_ID: '' }))).toThrow(
      /AGENTS_CONTRACT_ID is set but empty/
    );
  });

  it('rejects a malformed contract ID', () => {
    expect(() => loadAgentConfig(baseEnv({ USDC_CONTRACT_ID: 'dummy_usdc_contract' }))).toThrow(
      /USDC_CONTRACT_ID must be a Stellar contract ID/
    );
  });
});

describe('loadAgentConfig — service and token settings (LDS-2026-193)', () => {
  it('rejects a missing RPC URL', () => {
    const env = baseEnv();
    delete env.STELLAR_RPC_URL;
    expect(() => loadAgentConfig(env)).toThrow(/STELLAR_RPC_URL is required but not set/);
  });

  it('rejects an unparseable RPC URL', () => {
    expect(() => loadAgentConfig(baseEnv({ STELLAR_RPC_URL: 'not a url' }))).toThrow(
      /STELLAR_RPC_URL must be a valid URL/
    );
  });

  it('rejects a non-http(s) API URL', () => {
    expect(() => loadAgentConfig(baseEnv({ LODESTAR_API_URL: 'ftp://example.com' }))).toThrow(
      /LODESTAR_API_URL must use http or https/
    );
  });

  it('rejects non-positive spend limits', () => {
    expect(() => loadAgentConfig(baseEnv({ AGENT_MAX_PER_TX: '0' }))).toThrow(
      /AGENT_MAX_PER_TX must be a positive number/
    );
    expect(() => loadAgentConfig(baseEnv({ AGENT_MAX_PER_DAY: 'abc' }))).toThrow(
      /AGENT_MAX_PER_DAY must be a positive number/
    );
  });

  it('rejects an empty category list', () => {
    expect(() => loadAgentConfig(baseEnv({ AGENT_ALLOWED_CATEGORIES: ' , ,' }))).toThrow(
      /AGENT_ALLOWED_CATEGORIES must list at least one category/
    );
  });

  it('rejects out-of-range integer settings', () => {
    expect(() => loadAgentConfig(baseEnv({ AGENT_MIN_SERVICE_REPUTATION: '-1' }))).toThrow(
      /AGENT_MIN_SERVICE_REPUTATION must be an integer >= 0/
    );
    expect(() => loadAgentConfig(baseEnv({ AGENT_MAX_SERVICE_RETRIES: '0' }))).toThrow(
      /AGENT_MAX_SERVICE_RETRIES must be an integer >= 1/
    );
  });
});

describe('loadAgentConfig — safety properties', () => {
  it('never includes env values in error messages', () => {
    const sentinel = 'S3CR3T-ish-value-do-not-leak';
    try {
      loadAgentConfig(baseEnv({ STELLAR_RPC_URL: sentinel }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).not.toContain(sentinel);
      expect(err.message).not.toContain('SENTINEL_SECRET_VALUE');
    }
  });

  it('is deterministic: same input produces the same error', () => {
    const env = baseEnv({ STELLAR_NETWORK: 'bogus' });
    const first = () => loadAgentConfig(env);
    const second = () => loadAgentConfig(env);
    expect(first).toThrow(ConfigError);
    let a; let b;
    try { first(); } catch (e) { a = e.message; }
    try { second(); } catch (e) { b = e.message; }
    expect(a).toBe(b);
  });
});
