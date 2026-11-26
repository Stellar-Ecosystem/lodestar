import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Mocks (must be declared before any dynamic imports) ───────────────────────

vi.mock('dotenv/config', () => ({}));

vi.mock('pino', () => ({
  default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@stellar/stellar-sdk', () => ({
  default: {
    Keypair: {
      fromSecret: (secret) => {
        if (secret === 'SINVALID') throw new Error('bad secret');
        return { publicKey: () => 'GAGENTADDRESSMOCK000000000000000000000000000000000000000' };
      },
    },
  },
}));

vi.mock('@x402/core/client', () => ({
  x402Client: class { register() { return this; } },
  x402HTTPClient: class { encodePaymentSignatureHeader() { return {}; } },
}));

vi.mock('@x402/stellar', () => ({ createEd25519Signer: () => ({}) }));
vi.mock('@x402/stellar/exact/client', () => ({ ExactStellarScheme: class {} }));

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_SECRET = 'STEST0000000000000000000000000000000000000000000000000000';
const VALID_RPC    = 'https://mock-rpc.example.com';
const VALID_API    = 'http://localhost:9999';

function setValidEnv() {
  process.env.AGENT_STELLAR_SECRET = VALID_SECRET;
  process.env.STELLAR_RPC_URL      = VALID_RPC;
  process.env.LODESTAR_API_URL     = VALID_API;
}

async function importAgent() {
  vi.resetModules();
  return import('./agent.js');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('agent configuration — clean environment', () => {
  beforeEach(() => {
    delete process.env.AGENT_STELLAR_SECRET;
    delete process.env.AGENT_STELLAR_SECRET_FILE;
    delete process.env.STELLAR_RPC_URL;
    delete process.env.LODESTAR_API_URL;
  });

  afterEach(() => {
    delete process.env.AGENT_STELLAR_SECRET;
    delete process.env.AGENT_STELLAR_SECRET_FILE;
    delete process.env.STELLAR_RPC_URL;
    delete process.env.LODESTAR_API_URL;
  });

  it('throws when AGENT_STELLAR_SECRET is missing', async () => {
    process.env.STELLAR_RPC_URL  = VALID_RPC;
    process.env.LODESTAR_API_URL = VALID_API;

    await expect(importAgent()).rejects.toThrow(
      'Missing AGENT_STELLAR_SECRET or AGENT_STELLAR_SECRET_FILE'
    );
  });

  it('throws when both AGENT_STELLAR_SECRET and AGENT_STELLAR_SECRET_FILE are set', async () => {
    process.env.AGENT_STELLAR_SECRET      = VALID_SECRET;
    process.env.AGENT_STELLAR_SECRET_FILE = '/tmp/secret.txt';
    process.env.STELLAR_RPC_URL           = VALID_RPC;
    process.env.LODESTAR_API_URL          = VALID_API;

    await expect(importAgent()).rejects.toThrow(
      'Set only one of AGENT_STELLAR_SECRET or AGENT_STELLAR_SECRET_FILE, not both'
    );
  });

  it('throws when STELLAR_RPC_URL is missing', async () => {
    process.env.AGENT_STELLAR_SECRET = VALID_SECRET;
    process.env.LODESTAR_API_URL     = VALID_API;

    await expect(importAgent()).rejects.toThrow('Missing required env var: STELLAR_RPC_URL');
  });

  it('throws when LODESTAR_API_URL is missing', async () => {
    process.env.AGENT_STELLAR_SECRET = VALID_SECRET;
    process.env.STELLAR_RPC_URL      = VALID_RPC;

    await expect(importAgent()).rejects.toThrow('Missing required env var: LODESTAR_API_URL');
  });

  it('throws when AGENT_STELLAR_SECRET is an invalid key', async () => {
    process.env.AGENT_STELLAR_SECRET = 'SINVALID';
    process.env.STELLAR_RPC_URL      = VALID_RPC;
    process.env.LODESTAR_API_URL     = VALID_API;

    await expect(importAgent()).rejects.toThrow(
      'Invalid AGENT_STELLAR_SECRET: unable to parse secret key'
    );
  });

  it('loads successfully with all required vars set', async () => {
    setValidEnv();

    const mod = await importAgent();

    expect(mod.EVENT).toBeDefined();
    expect(typeof mod.runTask).toBe('function');
    expect(typeof mod.ensureRegistered).toBe('function');
  });

  it('does not expose the secret after module load', async () => {
    setValidEnv();

    const mod = await importAgent();

    // The module must not export or attach the raw secret anywhere.
    expect(Object.values(mod).every(v => v !== VALID_SECRET)).toBe(true);
  });
});
