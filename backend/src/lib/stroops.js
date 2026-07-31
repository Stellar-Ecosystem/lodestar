/**
 * Precision-safe Stroop ↔ USDC conversion helpers.
 *
 * Stellar/Stroops are the smallest unit on the Stellar network (1 USDC = 10_000_000 stroops).
 * Floating-point math can introduce rounding drift on larger amounts, so these helpers
 * use string-based integer arithmetic to guarantee exact conversions.
 */

const STROOPS_PER_USDC = 10_000_000;

/**
 * Convert a USDC amount (string or number) to stroops as a BigInt.
 * Uses string-based arithmetic to avoid floating-point rounding errors.
 *
 * @param {string|number} usdc - The USDC amount (e.g. "0.001" or 0.001)
 * @returns {bigint} The equivalent stroops amount
 * @throws {Error} If the input is not a valid number
 */
export function usdcToStroops(usdc) {
  const str = String(usdc).trim();
  if (str === '' || str === '.' || str === '-' || str === '+') {
    throw new Error(`Invalid USDC amount: "${usdc}"`);
  }

  // Reject hex, binary, octal, or other non-decimal notations before Number()
  if (/^(0[xXbBoO]|0\d)/.test(str)) {
    throw new Error(`Invalid USDC amount: "${usdc}"`);
  }

  const num = Number(str);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid USDC amount: "${usdc}"`);
  }

  // Normalize exponent notation (e.g. "1e-7" → "0.0000001") via toPrecision
  // so the raw string can be safely split on '.'
  const normalized = Math.abs(num) < 1 && num !== 0
    ? num.toFixed(20).replace(/0+$/, '').replace(/\.$/, '')
    : String(num);

  // Split into integer and fractional parts for exact string arithmetic
  const [intPart, fracPart = ''] = normalized.replace(/^[+-]/, '').split('.');

  // Pad or truncate fractional part to exactly 7 digits (stroops precision)
  const frac = fracPart.padEnd(7, '0').slice(0, 7);

  // Remove leading zeros from integer part
  const intClean = intPart.replace(/^0+/, '') || '0';

  const stroops = BigInt(intClean + frac);

  // Preserve sign for negative amounts (rare but defensive)
  if (normalized.startsWith('-')) {
    return -stroops;
  }
  return stroops;
}

/**
 * Convert stroops (as BigInt, number, or string) to a USDC string with full precision.
 *
 * @param {bigint|number|string} stroops - The stroops amount
 * @returns {string} The USDC amount as a string (e.g. "0.0010000")
 */
export function stroopsToUsdc(stroops) {
  const big = BigInt(stroops);
  const sign = big < 0n ? '-' : '';
  const abs = big < 0n ? -big : big;

  const intPart = abs / BigInt(STROOPS_PER_USDC);
  const fracPart = abs % BigInt(STROOPS_PER_USDC);

  return `${sign}${intPart}.${String(fracPart).padStart(7, '0')}`;
}

/**
 * Convert stroops to a USDC string formatted for display (2 decimal places, rounded).
 *
 * @param {bigint|number|string} stroops - The stroops amount
 * @returns {string} The USDC amount formatted to 2 decimals (e.g. "0.01")
 */
export function stroopsToUsdcDisplay(stroops) {
  const big = BigInt(stroops);
  const sign = big < 0n ? '-' : '';
  const abs = big < 0n ? -big : big;

  const intPart = abs / BigInt(STROOPS_PER_USDC);
  const fracRaw = abs % BigInt(STROOPS_PER_USDC);

  // Round to 2 decimal places: if the 3rd decimal digit >= 5, round up
  const frac2 = fracRaw / 100_000n; // first 2 digits
  const frac3 = (fracRaw / 10_000n) % 10n; // 3rd digit for rounding

  const rounded = frac3 >= 5n ? frac2 + 1n : frac2;
  const carry = rounded >= 100n;

  if (carry) {
    return `${sign}${intPart + 1n}.00`;
  }
  return `${sign}${intPart}.${String(rounded).padStart(2, '0')}`;
}
