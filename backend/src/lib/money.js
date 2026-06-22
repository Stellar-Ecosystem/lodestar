const STROOPS_PER_USDC = 10_000_000n;

export function usdcToStroops(value) {
  const raw = String(value).trim();
  const match = raw.match(/^(\d+)(?:\.(\d+))?$/);

  if (!match) {
    throw new Error('Invalid USDC amount');
  }

  const [, wholePart, fractionPart = ''] = match;
  const paddedFraction = fractionPart.padEnd(8, '0');
  const stroopDigits = paddedFraction.slice(0, 7);
  const roundDigit = paddedFraction[7] ?? '0';

  let stroops = BigInt(wholePart) * STROOPS_PER_USDC + BigInt(stroopDigits || '0');
  if (roundDigit >= '5') {
    stroops += 1n;
  }

  return stroops;
}

export function stroopsToUsdc(stroops, fractionDigits = 2) {
  const value = BigInt(stroops);
  if (value < 0n) {
    throw new Error('Invalid stroops amount');
  }

  const whole = value / STROOPS_PER_USDC;
  const fraction = value % STROOPS_PER_USDC;

  if (fractionDigits === 0) {
    return whole.toString();
  }

  const scaled = fraction.toString().padStart(7, '0').slice(0, fractionDigits);
  return `${whole}.${scaled.padEnd(fractionDigits, '0')}`;
}
