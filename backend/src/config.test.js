import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Minimal set of required env vars so config.js loads without throwing.
const REQUIRED = {
  CONTRACT_ID: 'C_TEST',
  SERVER_STELLAR_ADDRESS: 'G_TEST',
  SERVER_STELLAR_SECRET: 'S_TEST',
  STELLAR_RPC_URL: 'https://rpc.test',
  STELLAR_NETWORK_PASSPHRASE: 'Test',
  FACILITATOR_URL: 'https://facilitator.test',
  USDC_CONTRACT_ID: 'C_USDC',
};

const ORIGINAL_ENV = { ...process.env };

async function loadConfig(overrides = {}) {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, ...REQUIRED, ...overrides };
  // Strip any rate-limit/proxy vars not explicitly provided so defaults apply.
  for (const key of [
    'RATE_LIMIT_WINDOW_MS',
    'RATE_LIMIT_MAX',
    'PAYMENT_RATE_LIMIT_WINDOW_MS',
    'PAYMENT_RATE_LIMIT_MAX',
    'TRUST_PROXY',
  ]) {
    if (!(key in overrides)) delete process.env[key];
  }
  return (await import('./config.js')).default;
}

describe('config rate-limit env validation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('uses safe defaults when rate-limit vars are unset', async () => {
    const config = await loadConfig();
    expect(config.rateLimit.windowMs).toBe(60_000);
    expect(config.rateLimit.max).toBe(20);
    expect(config.rateLimit.payment.windowMs).toBe(60_000);
    expect(config.rateLimit.payment.max).toBe(10);
  });

  it('honors valid positive-integer overrides', async () => {
    const config = await loadConfig({ RATE_LIMIT_MAX: '5', RATE_LIMIT_WINDOW_MS: '1000' });
    expect(config.rateLimit.max).toBe(5);
    expect(config.rateLimit.windowMs).toBe(1000);
  });

  it('falls back and warns on non-numeric values', async () => {
    const config = await loadConfig({ RATE_LIMIT_MAX: 'abc' });
    expect(config.rateLimit.max).toBe(20);
    expect(console.warn).toHaveBeenCalled();
  });

  it('falls back on zero or negative values', async () => {
    const config = await loadConfig({ RATE_LIMIT_MAX: '0', PAYMENT_RATE_LIMIT_MAX: '-3' });
    expect(config.rateLimit.max).toBe(20);
    expect(config.rateLimit.payment.max).toBe(10);
  });
});

describe('config trustProxy parsing', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('defaults to false when unset', async () => {
    const config = await loadConfig();
    expect(config.trustProxy).toBe(false);
  });

  it('parses "true"/"false" booleans', async () => {
    expect((await loadConfig({ TRUST_PROXY: 'true' })).trustProxy).toBe(true);
    expect((await loadConfig({ TRUST_PROXY: 'false' })).trustProxy).toBe(false);
  });

  it('parses a numeric hop count', async () => {
    expect((await loadConfig({ TRUST_PROXY: '1' })).trustProxy).toBe(1);
  });

  it('passes through an IP/subnet string', async () => {
    expect((await loadConfig({ TRUST_PROXY: '127.0.0.1' })).trustProxy).toBe('127.0.0.1');
  });
});
