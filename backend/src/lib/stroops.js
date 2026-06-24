const STROOPS_PER_USDC = 10_000_000n;
const DECIMAL_PLACES = 7;

/**
 * Convert a USDC amount string to stroops (BigInt), using integer arithmetic
 * to avoid floating-point rounding drift on amounts with many decimal places.
 *
 * @param {string|number} usdc - Positive decimal string e.g. "0.001" or "1.5"
 * @returns {bigint}
 * @throws {Error} if the value is not a valid non-negative decimal number
 */
export function usdcToStroops(usdc) {
  const str = String(usdc).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new Error(`usdcToStroops: invalid USDC value "${str}"`);
  }

  const dotIdx = str.indexOf('.');
  if (dotIdx === -1) {
    return BigInt(str) * STROOPS_PER_USDC;
  }

  const intPart = str.slice(0, dotIdx);
  const rawFrac = str.slice(dotIdx + 1);
  const frac = rawFrac.slice(0, DECIMAL_PLACES).padEnd(DECIMAL_PLACES, '0');

  return BigInt(intPart) * STROOPS_PER_USDC + BigInt(frac);
}

/**
 * Convert a stroops BigInt to a USDC decimal string (7 decimal places, trailing zeros trimmed).
 *
 * @param {bigint} stroops
 * @returns {string} e.g. "0.001"
 */
export function stroopsToUsdc(stroops) {
  const n = BigInt(stroops);
  const int = n / STROOPS_PER_USDC;
  const frac = n % STROOPS_PER_USDC;
  const fracStr = frac.toString().padStart(DECIMAL_PLACES, '0').replace(/0+$/, '');
  return fracStr ? `${int}.${fracStr}` : `${int}`;
}
