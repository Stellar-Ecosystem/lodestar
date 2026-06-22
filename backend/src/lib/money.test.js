import { describe, expect, it } from 'vitest';
import { stroopsToUsdc, usdcToStroops } from './money.js';

describe('usdcToStroops', () => {
  it('converts whole and decimal USDC values without floating-point math', () => {
    expect(usdcToStroops('1')).toBe(10_000_000n);
    expect(usdcToStroops('0.001')).toBe(10_000n);
    expect(usdcToStroops('123456789012345.1234567')).toBe(1_234_567_890_123_451_234_567n);
  });

  it('rounds values beyond stroop precision to the nearest stroop', () => {
    expect(usdcToStroops('0.00000004')).toBe(0n);
    expect(usdcToStroops('0.00000005')).toBe(1n);
    expect(usdcToStroops('1.00000015')).toBe(10_000_002n);
  });

  it('rejects malformed or negative amounts', () => {
    expect(() => usdcToStroops('')).toThrow('Invalid USDC amount');
    expect(() => usdcToStroops('abc')).toThrow('Invalid USDC amount');
    expect(() => usdcToStroops('-1')).toThrow('Invalid USDC amount');
  });
});

describe('stroopsToUsdc', () => {
  it('formats stroops without converting through Number', () => {
    expect(stroopsToUsdc(10_000_000n)).toBe('1.00');
    expect(stroopsToUsdc(12_345_678n, 4)).toBe('1.2345');
    expect(stroopsToUsdc(1_234_567_890_123_451_234_567n, 7)).toBe(
      '123456789012345.1234567'
    );
  });

  it('rejects negative stroops', () => {
    expect(() => stroopsToUsdc(-1n)).toThrow('Invalid stroops amount');
  });
});
