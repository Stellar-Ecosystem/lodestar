/**
 * Shared request-schema primitives.
 *
 * Every rule the API enforces on an incoming request is declared in
 * `src/schemas/`. Route handlers read already-validated, already-coerced input
 * from `req.valid` and never re-check it.
 *
 * These schemas are also the source of the OpenAPI document: zod v4's
 * `z.toJSONSchema()` turns each one into JSON Schema, so the spec cannot
 * describe anything different from what the server enforces.
 */
import { z } from "zod";

export const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

/** Decimal string with no leading zeros, e.g. "0", "0.5", "12.3456". */
const DECIMAL_REGEX = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Positive integer string with no leading zeros, e.g. "1", "42". */
const POSITIVE_INT_REGEX = /^[1-9]\d*$/;

/** Non-negative integer string, e.g. "0", "7". */
const NON_NEGATIVE_INT_REGEX = /^(?:0|[1-9]\d*)$/;

/** Smallest price the registry accepts, in USDC. */
export const MIN_PRICE_USDC = 0.0001;

export const SERVICE_CATEGORIES = [
  "search",
  "weather",
  "finance",
  "ai",
  "data",
  "compute",
];

/**
 * Predicate form of the address rule, for the handful of places that check an
 * address which did not arrive as part of a request — the `x-payment-address`
 * header credited by the x402 middleware, for instance.
 */
export function isValidStellarAddress(address) {
  return typeof address === "string" && STELLAR_ADDRESS_REGEX.test(address);
}

/**
 * A Stellar ed25519 public key.
 *
 * @param {string} [message] - Message used for both a missing value and a
 *   malformed one, so callers get a single consistent sentence either way.
 */
export function stellarAddress(message = "Invalid Stellar address format") {
  return z
    .string({ error: message })
    .regex(STELLAR_ADDRESS_REGEX, { error: message })
    .describe("Stellar ed25519 public key (starts with G, 56 characters)");
}

/**
 * A `:id` path segment naming a registry service.
 *
 * Path params arrive as strings, so this rejects anything that is not a bare
 * positive integer — "7abc" is not silently read as 7 the way `parseInt` does.
 */
export function serviceIdParam(message = "Invalid service ID") {
  return z
    .string({ error: message })
    .regex(POSITIVE_INT_REGEX, { error: message })
    .transform(Number)
    .refine(Number.isSafeInteger, { error: message })
    .describe("Registry service ID (positive integer)");
}

/**
 * A positive integer supplied in a JSON body, where it may legitimately arrive
 * as either a number or a numeric string.
 */
export function positiveIntegerField(field) {
  const message = `\`${field}\` must be a positive integer`;
  return z
    .union([z.number(), z.string()], { error: message })
    .transform((value, ctx) => {
      const parsed = typeof value === "number" ? value : Number(value);
      const wellFormed =
        typeof value === "number" || POSITIVE_INT_REGEX.test(value);
      if (!wellFormed || !Number.isSafeInteger(parsed) || parsed <= 0) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return parsed;
    })
    .describe("Positive integer (number or numeric string)");
}

/**
 * A USDC amount supplied as a number or numeric string, handed to the handler
 * as a finite number. Non-numeric input is a 400 rather than, as before, a
 * `BigInt(NaN)` throw surfacing as a 500.
 */
export function usdcAmountField(field) {
  const message = `\`${field}\` must be a non-negative number of USDC`;
  return z
    .union([z.number(), z.string()], { error: message })
    .transform((value, ctx) => {
      const parsed = typeof value === "number" ? value : Number(value.trim());
      if (typeof value === "string" && value.trim() === "") {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      if (!Number.isFinite(parsed) || parsed < 0) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return parsed;
    })
    .describe("Amount in USDC (number or numeric string)");
}

/**
 * A stroops amount destined for the contract, accepted as a number or string
 * and handed on unchanged — `contract.js` owns the BigInt conversion.
 */
export function stroopsField(field) {
  const message = `\`${field}\` is required (string or number)`;
  return z
    .union([z.number(), z.string()], { error: message })
    .refine((value) => (typeof value === "number" ? value > 0 : value.length > 0), {
      error: message,
    })
    .describe("Amount in stroops (1 USDC = 10,000,000 stroops)");
}

/**
 * A USDC price, normalised to its canonical decimal-string form.
 *
 * Accepts a number or a string; rejects padded strings ("1.5 "), exponent
 * notation, and anything below {@link MIN_PRICE_USDC}.
 */
const PRICE_USDC_MESSAGE = `\`priceUsdc\` must be at least ${MIN_PRICE_USDC}`;

export const priceUsdc = z
  .union([z.number(), z.string()], { error: PRICE_USDC_MESSAGE })
  .transform((value, ctx) => {
    const normalized = normalizePriceUsdc(value);
    if (normalized === null) {
      ctx.addIssue({ code: "custom", message: PRICE_USDC_MESSAGE });
      return z.NEVER;
    }
    return normalized;
  })
  .describe(`Price in USDC as a decimal string, minimum ${MIN_PRICE_USDC}`);

/**
 * Canonical decimal-string form of a USDC price, or null when the input is not
 * a usable price. Exported so tests can exercise the normalisation directly.
 */
export function normalizePriceUsdc(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const normalized = String(value);
    if (!DECIMAL_REGEX.test(normalized)) return null;
    return value >= MIN_PRICE_USDC ? normalized : null;
  }

  if (typeof value !== "string") return null;
  if (value.trim() !== value || value.length === 0) return null;
  if (!DECIMAL_REGEX.test(value)) return null;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_PRICE_USDC) return null;

  return value;
}

/** Non-negative integer from a query string, e.g. `?page=3`. */
export function intQueryParam({ field, min = 0, max, defaultValue, message }) {
  const error =
    message ??
    `\`${field}\` must be an integer${min === 0 ? " >= 0" : ` >= ${min}`}`;
  const pattern = min > 0 ? POSITIVE_INT_REGEX : NON_NEGATIVE_INT_REGEX;

  let schema = z
    .string({ error })
    .regex(pattern, { error })
    .transform(Number)
    .refine((n) => Number.isSafeInteger(n) && n >= min, { error });

  // Clamp rather than reject at the top end: an over-large page size is a
  // caller being optimistic, not a caller being wrong.
  if (max !== undefined) schema = schema.transform((n) => Math.min(n, max));

  // `.default()` takes the *output* value in zod v4 — it short-circuits parsing
  // when the query param is absent rather than feeding a string through.
  return defaultValue === undefined
    ? schema.optional()
    : schema.optional().default(defaultValue);
}

/** Finite decimal (possibly negative) from a query string, e.g. `?lat=-74.006`. */
export function floatQueryParam({ field, min, max, defaultValue, message }) {
  // Note: `.refine`/`.string` take `error`, but `ctx.addIssue` takes `message`.
  // Passing `error` to `addIssue` degrades silently to zod's "Invalid input".
  const text = message ?? `\`${field}\` must be a number between ${min} and ${max}`;

  const schema = z
    .string({ error: text })
    .transform((value, ctx) => {
      const parsed = Number(value);
      if (value.trim() === "" || !Number.isFinite(parsed)) {
        ctx.addIssue({ code: "custom", message: text });
        return z.NEVER;
      }
      return parsed;
    })
    .refine((n) => (min === undefined || n >= min) && (max === undefined || n <= max), {
      error: text,
    });

  return defaultValue === undefined
    ? schema.optional()
    : schema.optional().default(defaultValue);
}

/**
 * The `X-Idempotency-Key` header: 1–255 printable ASCII characters, no spaces.
 *
 * A present-but-malformed key carries its own code on the issue so it stays
 * distinguishable from an absent one, which falls through to the route's
 * default code (`IDEMPOTENCY_KEY_MISSING`).
 */
export const idempotencyKeyHeader = z
  .string({ error: "Missing X-Idempotency-Key header" })
  .refine(
    (key) => key.length >= 1 && key.length <= 255 && /^[\x21-\x7E]+$/.test(key),
    {
      error:
        "X-Idempotency-Key must be 1–255 printable ASCII characters (no spaces)",
      params: { code: "IDEMPOTENCY_KEY_INVALID" },
    },
  )
  .meta({
    minLength: 1,
    maxLength: 255,
    description:
      "Unique key per logical payment; retrying with the same key replays the first result",
  });

/** A base64 transaction envelope handed back by a wallet. */
export function signedXdrField(field = "signedXdr") {
  const message = `\`${field}\` is required`;
  return z
    .string({ error: message })
    .min(1, { error: message })
    .describe("Base64-encoded signed Stellar transaction envelope (XDR)");
}

/** A required, non-empty free-text field. */
export function requiredString(field, { min = 1, max, description } = {}) {
  const message =
    max === undefined
      ? `\`${field}\` is required`
      : `\`${field}\` must be ${min}–${max} characters`;

  let schema = z.string({ error: message }).trim().min(min, { error: message });
  if (max !== undefined) schema = schema.max(max, { error: message });

  return description ? schema.describe(description) : schema;
}

export { z };
