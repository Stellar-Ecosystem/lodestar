import { describe, it, expect, vi } from 'vitest';
import {
  redactUrl,
  redactReference,
  isValidUsdcToken,
  isValidHttpUrl,
  validateAgentConfig,
  logConfigOutcome,
} from './configTrace.js';

const VALID_CONTRACT = 'C' + 'A'.repeat(55);
const VALID_ISSUER = 'G' + 'B'.repeat(55);

describe('redactUrl', () => {
  it('strips credentials, query params, and fragments from http(s) URLs', () => {
    expect(redactUrl('https://user:pass@api.example.com/weather?apiKey=secret&lat=40#frag')).toBe(
      'https://api.example.com/weather',
    );
  });

  it('redacts non-http schemes', () => {
    expect(redactUrl('ftp://secret@files.example.com/path')).toBe('ftp://[redacted]');
  });

  it('redacts malformed URLs without leaking query parameters or credentials', () => {
    expect(redactUrl('not-a-url?token=supersecret')).toBe('***');
    expect(redactUrl('malformed-facilitator-endpoint?key=123')).toBe('malfor...oint');
    expect(redactUrl('user:pass@malformed-facilitator-endpoint?key=123')).toBe('user://[redacted]');
  });

  it('returns null for empty or non-string values', () => {
    expect(redactUrl('')).toBeNull();
    expect(redactUrl(null)).toBeNull();
    expect(redactUrl(undefined)).toBeNull();
  });
});

describe('redactReference', () => {
  it('redacts long payment hashes while keeping prefix and suffix for correlation', () => {
    expect(redactReference('abcdef1234567890fedcba')).toBe('abcd...dcba');
  });

  it('redacts short values completely', () => {
    expect(redactReference('short')).toBe('***');
  });

  it('redacts URLs via redactUrl', () => {
    expect(redactReference('https://svc.example.com/pay?sig=abc')).toBe('https://svc.example.com/pay');
  });

  it('returns null for empty values or placeholder "(no hash)"', () => {
    expect(redactReference('(no hash)')).toBeNull();
    expect(redactReference('')).toBeNull();
    expect(redactReference(null)).toBeNull();
  });
});

describe('validators', () => {
  it('accepts Soroban contract IDs and Stellar classic assets for USDC token', () => {
    expect(isValidUsdcToken(VALID_CONTRACT)).toBe(true);
    expect(isValidUsdcToken(`USDC:${VALID_ISSUER}`)).toBe(true);
    expect(isValidUsdcToken('not-a-token')).toBe(false);
    expect(isValidUsdcToken('USDC:INVALID')).toBe(false);
  });

  it('accepts only http(s) URLs with a hostname', () => {
    expect(isValidHttpUrl('https://facilitator.example.com')).toBe(true);
    expect(isValidHttpUrl('http://localhost:3001')).toBe(true);
    expect(isValidHttpUrl('ftp://facilitator.example.com')).toBe(false);
    expect(isValidHttpUrl('not-a-url')).toBe(false);
  });
});

describe('validateAgentConfig & logConfigOutcome', () => {
  const events = {
    CONFIG_VALIDATED: 'config_validated',
    CONFIG_INVALID: 'config_invalid',
  };

  it('passes when optional USDC token and facilitator URL are valid', () => {
    const result = validateAgentConfig({
      STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org?key=secret',
      LODESTAR_API_URL: 'http://localhost:3001',
      AGENT_USDC_TOKEN: VALID_CONTRACT,
      FACILITATOR_URL: 'https://facilitator.example.com/v1?auth=secret',
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.summary).toEqual({
      rpcUrl: 'https://soroban-testnet.stellar.org/',
      apiUrl: 'http://localhost:3001/',
      usdcToken: `${VALID_CONTRACT.slice(0, 4)}...${VALID_CONTRACT.slice(-4)}`,
      facilitatorUrl: 'https://facilitator.example.com/v1',
    });
  });

  it('reports invalid USDC token and invalid facilitator URL with redacted values', () => {
    const result = validateAgentConfig({
      STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
      LODESTAR_API_URL: 'http://localhost:3001',
      AGENT_USDC_TOKEN: 'INVALID_USDC_TOKEN_SECRET_1234',
      FACILITATOR_URL: 'ftp://user:pass@bad-facilitator.example.com',
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      {
        field: 'usdcToken',
        envVar: 'AGENT_USDC_TOKEN',
        reason: 'invalid_usdc_token',
        value: 'INVA...1234',
      },
      {
        field: 'facilitatorUrl',
        envVar: 'FACILITATOR_URL',
        reason: 'invalid_facilitator_url',
        value: 'ftp://[redacted]',
      },
    ]);

    const logger = { info: vi.fn(), warn: vi.fn() };
    logConfigOutcome(logger, result, { runId: 'run-123', agentAddress: 'GTEST', events });

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'config_invalid',
        runId: 'run-123',
        field: 'usdcToken',
        reason: 'invalid_usdc_token',
      }),
      'Invalid agent configuration value',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'config_invalid',
        runId: 'run-123',
        field: 'facilitatorUrl',
        reason: 'invalid_facilitator_url',
      }),
      'Invalid agent configuration value',
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'config_validated',
        runId: 'run-123',
        valid: false,
        issueCount: 2,
      }),
      'Agent configuration validated with issues',
    );
  });
});
