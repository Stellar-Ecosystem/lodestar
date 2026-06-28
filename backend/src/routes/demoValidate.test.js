process.env.CONTRACT_ID = 'dummy';
process.env.SERVER_STELLAR_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env.SERVER_STELLAR_SECRET = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env.STELLAR_RPC_URL = 'https://horizon-testnet.stellar.org';
process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
process.env.FACILITATOR_URL = 'http://localhost';
process.env.USDC_CONTRACT_ID = 'dummy-usdc';
process.env.NODE_ENV = 'test';

import { describe, it, expect } from 'vitest';
import { validateDemoEndpoint } from './demoValidate.js';

const config = { port: 3001 };

// Mock config import inside demoValidate (it imports from '../config.js')
// We'll set process.env.NODE_ENV? Actually demoValidate imports config directly, which reads from actual config.
// For test purposes we can rely on default config.port which is likely 3001; assume it's correct.

describe('validateDemoEndpoint', () => {
  it('allows a proper weather endpoint', () => {
    const url = `https://registry.example/demo/weather?lat=10&lon=20`;
    const result = validateDemoEndpoint(url, 'weather');
    expect(result).toContain('http://127.0.0.1');
    expect(result).toContain('/demo/weather');
    expect(result).toContain('lat=10');
    expect(result).toContain('lon=20');
  });

  it('allows a proper search endpoint', () => {
    const url = `https://registry.example/demo/search?q=test`;
    const result = validateDemoEndpoint(url, 'search');
    expect(result).toContain('http://127.0.0.1');
    expect(result).toContain('/demo/search');
    expect(result).toContain('q=test');
  });

  it('rejects an endpoint with disallowed path', () => {
    const url = `https://registry.example/api/agents/register`;
    expect(() => validateDemoEndpoint(url, 'weather')).toThrowError('Endpoint not allowed');
  });

  it('rejects malformed URL', () => {
    const url = `not a url`;
    expect(() => validateDemoEndpoint(url, 'weather')).toThrowError('Invalid endpoint URL');
  });
});
