import { AGENTS_CONTRACT_ID, DEMO_AGENT_ADDRESS } from '../lib/contract';

describe('contract module constants', () => {
  describe('AGENTS_CONTRACT_ID', () => {
    it('is exported as a string', () => {
      expect(typeof AGENTS_CONTRACT_ID).toBe('string');
    });

    it('falls back to empty string when NEXT_PUBLIC_AGENTS_CONTRACT_ID is not set', () => {
      // In the test environment no env var is configured, so the default kicks in.
      expect(AGENTS_CONTRACT_ID).toBe('');
    });
  });

  describe('DEMO_AGENT_ADDRESS', () => {
    it('is exported as a string', () => {
      expect(typeof DEMO_AGENT_ADDRESS).toBe('string');
    });

    it('falls back to empty string when NEXT_PUBLIC_DEMO_AGENT_ADDRESS is not set', () => {
      expect(DEMO_AGENT_ADDRESS).toBe('');
    });
  });
});
