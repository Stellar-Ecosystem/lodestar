/**
 * Registry validation helpers — pure functions with no side effects.
 * Unit-testable without HTTP or contract dependencies.
 */
import { isValidStellarAddress } from '../middleware/addressValidator.js';

export const SERVICE_CATEGORIES = new Set(["search", "weather", "finance", "ai", "data", "compute"]);
const PRICE_USDC_REGEX = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * Normalize a USDC price value to a string, or return null if invalid.
 * Accepts numbers and strings; rejects non-finite, zero, or malformed values.
 */
export function normalizePriceUsdc(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const normalized = String(value);
    if (!PRICE_USDC_REGEX.test(normalized)) return null;
    return value >= 0.0001 ? normalized : null;
  }

  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized !== value || !PRICE_USDC_REGEX.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0.0001) {
    return null;
  }

  return normalized;
}

/**
 * Parse a value as a positive safe integer, returning the number or null.
 */
export function parsePositiveSafeInteger(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Result of a failed validation — the route layer maps this to an HTTP response.
 */
export class ValidationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Validate a registration request body. Returns the normalized payload
 * or throws a ValidationError.
 */
export function validateRegisterBody(body = {}) {
  const { name, description, endpoint, priceUsdc, category, providerAddress, payTo } = body;

  if (!isValidStellarAddress(providerAddress)) {
    throw new ValidationError(400, 'INVALID_BODY', '`providerAddress` must be a valid Stellar address');
  }
  if (typeof name !== "string" || name.trim().length < 3 || name.trim().length > 50) {
    throw new ValidationError(400, 'INVALID_BODY', '`name` must be 3-50 characters');
  }
  if (typeof description !== "string" || description.trim().length < 10 || description.trim().length > 200) {
    throw new ValidationError(400, 'INVALID_BODY', '`description` must be 10-200 characters');
  }
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    throw new ValidationError(400, 'INVALID_BODY', '`endpoint` must start with https://');
  }
  if (!SERVICE_CATEGORIES.has(category)) {
    throw new ValidationError(400, 'INVALID_BODY', '`category` is invalid');
  }

  const normalizedPriceUsdc = normalizePriceUsdc(priceUsdc);
  if (!normalizedPriceUsdc) {
    throw new ValidationError(400, 'INVALID_BODY', '`priceUsdc` must be at least 0.0001');
  }
  if (payTo !== undefined && (typeof payTo !== "string" || payTo.trim().length === 0)) {
    throw new ValidationError(400, 'INVALID_BODY', '`payTo` must be a non-empty string when provided');
  }

  return {
    name: name.trim(),
    description: description.trim(),
    endpoint: endpoint.trim(),
    priceUsdc: normalizedPriceUsdc,
    category,
    providerAddress,
    payTo: payTo?.trim(),
  };
}

/**
 * Validate a deactivation request body.
 */
export function validateDeactivateBody(body = {}) {
  const { providerAddress, id } = body;

  if (!isValidStellarAddress(providerAddress)) {
    throw new ValidationError(400, 'INVALID_BODY', '`providerAddress` must be a valid Stellar address');
  }

  const parsedId = parsePositiveSafeInteger(id);
  if (parsedId == null) {
    throw new ValidationError(400, 'INVALID_BODY', '`id` must be a positive integer');
  }

  return { providerAddress, id: parsedId };
}

/**
 * Validate a signed transaction submission body.
 */
export function validateSubmitSignedTxBody(body = {}) {
  const { signedXdr, submitToken } = body;

  if (!signedXdr || typeof signedXdr !== "string") {
    throw new ValidationError(400, 'INVALID_BODY', '`signedXdr` is required');
  }
  if (!submitToken || typeof submitToken !== "string") {
    throw new ValidationError(400, 'INVALID_BODY', '`submitToken` is required');
  }

  return { signedXdr, submitToken };
}

/**
 * Validate a reputation vote request body.
 */
export function validateReputationBody(body = {}) {
  const { positive, agent } = body;

  if (typeof positive !== "boolean") {
    throw new ValidationError(400, 'INVALID_BODY', '`positive` must be a boolean');
  }
  if (!isValidStellarAddress(agent)) {
    throw new ValidationError(400, 'INVALID_BODY', '`agent` must be a valid Stellar address');
  }

  return { positive, agent };
}
