import { describe, it, expect, afterEach } from 'vitest';
import { intFromEnv } from './agent.js';

const KEY = 'AGENT_TEST_INT_FROM_ENV';

afterEach(() => {
  delete process.env[KEY];
});

describe('intFromEnv', () => {
  it('returns default when unset', () => {
    expect(intFromEnv(KEY, 7)).toBe(7);
  });

  it('parses a valid integer', () => {
    process.env[KEY] = '42';
    expect(intFromEnv(KEY, 0)).toBe(42);
  });

  it('fails fast on unparseable values', () => {
    process.env[KEY] = 'abc';
    expect(() => intFromEnv(KEY, 0)).toThrow(/AGENT_TEST_INT_FROM_ENV must be an integer/);
  });

  it('enforces min bound', () => {
    process.env[KEY] = '-1';
    expect(() => intFromEnv(KEY, 0, { min: 0 })).toThrow(/must be >= 0/);
  });

  it('enforces max bound', () => {
    process.env[KEY] = '100';
    expect(() => intFromEnv(KEY, 0, { max: 10 })).toThrow(/must be <= 10/);
  });
});
