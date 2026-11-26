/**
 * Explicit unknown-state and retry boundary for x402 402-payment requests.
 *
 * Once a payment payload has been signed and dispatched to a service endpoint,
 * a lost response (timeout, network reset, or connection drop) leaves the
 * on-chain settlement outcome unknown. Retrying the same request — or falling
 * back to sign a second payment — risks double-paying for an already settled
 * request.
 */

export const PAYMENT_STATE = Object.freeze({
  UNPAID: 'unpaid',
  IN_FLIGHT: 'in_flight',
  SETTLED: 'settled',
  UNKNOWN: 'unknown',
});

export class PaymentStateUnknownError extends Error {
  constructor(url, requestKey, cause) {
    super(
      `Response lost after x402 payment submission for ${requestKey}; settlement state is unknown`
    );
    this.name = 'PaymentStateUnknownError';
    this.code = 'PAYMENT_STATE_UNKNOWN';
    this.paymentState = PAYMENT_STATE.UNKNOWN;
    this.url = url;
    this.requestKey = requestKey;
    this.cause = cause;
    this.retryable = false;
  }
}

export class PaymentRetryBlockedError extends Error {
  constructor(url, requestKey, paymentState, txHash = null) {
    super(
      `Retry blocked for ${requestKey}: payment state is already '${paymentState}'` +
        (txHash ? ` (txHash: ${txHash})` : '')
    );
    this.name = 'PaymentRetryBlockedError';
    this.code = 'PAYMENT_RETRY_BLOCKED';
    this.paymentState = paymentState;
    this.url = url;
    this.requestKey = requestKey;
    this.txHash = txHash;
    this.retryable = false;
  }
}

const STELLAR_CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

export function isValidUsdcToken(token) {
  return typeof token === 'string' && STELLAR_CONTRACT_ID_RE.test(token.trim());
}

export function isValidFacilitatorUrl(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export class InvalidPaymentConfigError extends Error {
  constructor({ code, field, message, url = null, requestKey = null }) {
    super(message);
    this.name = 'InvalidPaymentConfigError';
    this.code = code;
    this.field = field;
    this.paymentState = PAYMENT_STATE.UNKNOWN;
    this.url = url;
    this.requestKey = requestKey;
    this.retryable = false;
  }
}

export function isPaymentBoundaryError(err) {
  return (
    err instanceof PaymentStateUnknownError ||
    err instanceof PaymentRetryBlockedError ||
    err instanceof InvalidPaymentConfigError ||
    err?.code === 'PAYMENT_STATE_UNKNOWN' ||
    err?.code === 'PAYMENT_RETRY_BLOCKED' ||
    err?.code === 'INVALID_USDC_TOKEN' ||
    err?.code === 'INVALID_FACILITATOR_URL'
  );
}

export function validatePaymentConfig(config = {}, context = {}) {
  const { usdcToken, facilitatorUrl } = config;
  const { url = null, requestKey = null } = context;

  if (usdcToken !== undefined && !isValidUsdcToken(usdcToken)) {
    throw new InvalidPaymentConfigError({
      code: 'INVALID_USDC_TOKEN',
      field: 'usdcToken',
      message: 'Invalid USDC token contract ID in agent payment configuration; entering unknown state',
      url,
      requestKey,
    });
  }

  if (facilitatorUrl !== undefined && !isValidFacilitatorUrl(facilitatorUrl)) {
    throw new InvalidPaymentConfigError({
      code: 'INVALID_FACILITATOR_URL',
      field: 'facilitatorUrl',
      message: 'Invalid facilitator URL in agent payment configuration; entering unknown state',
      url,
      requestKey,
    });
  }
}

function normalizeUrl(url) {
  return new URL(url.trim()).href.replace(/\/+$/, '');
}

export function validatePaymentRequirements(paymentRequired, config = {}, context = {}) {
  if (!paymentRequired || typeof paymentRequired !== 'object') return;
  const { url = null, requestKey = null } = context;

  const entries = Array.isArray(paymentRequired.accepts)
    ? paymentRequired.accepts
    : [paymentRequired.requirements ?? paymentRequired];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    if (entry.asset !== undefined) {
      if (!isValidUsdcToken(entry.asset)) {
        throw new InvalidPaymentConfigError({
          code: 'INVALID_USDC_TOKEN',
          field: 'usdcToken',
          message: `Invalid USDC token asset '${entry.asset}' in 402 payment requirements; entering unknown state`,
          url,
          requestKey,
        });
      }
      if (config.usdcToken && entry.asset.trim() !== config.usdcToken.trim()) {
        throw new InvalidPaymentConfigError({
          code: 'INVALID_USDC_TOKEN',
          field: 'usdcToken',
          message: `Unexpected USDC token asset '${entry.asset}' in 402 payment requirements; entering unknown state`,
          url,
          requestKey,
        });
      }
    }

    const reqFacilitator =
      entry.facilitatorUrl !== undefined ? entry.facilitatorUrl : entry.extra?.facilitatorUrl;
    if (reqFacilitator !== undefined) {
      if (!isValidFacilitatorUrl(reqFacilitator)) {
        throw new InvalidPaymentConfigError({
          code: 'INVALID_FACILITATOR_URL',
          field: 'facilitatorUrl',
          message: `Invalid facilitator URL '${reqFacilitator}' in 402 payment requirements; entering unknown state`,
          url,
          requestKey,
        });
      }
      if (
        config.facilitatorUrl &&
        normalizeUrl(reqFacilitator) !== normalizeUrl(config.facilitatorUrl)
      ) {
        throw new InvalidPaymentConfigError({
          code: 'INVALID_FACILITATOR_URL',
          field: 'facilitatorUrl',
          message: `Unexpected facilitator URL '${reqFacilitator}' in 402 payment requirements; entering unknown state`,
          url,
          requestKey,
        });
      }
    }
  }
}

/**
 * Wrap an x402HTTPClient's 402-payment flow with an explicit retry boundary.
 *
 * - Pre-payment probe failures leave the request unpaid and safe to retry.
 * - Invalid USDC token or facilitator URL (in agent config or 402 requirements)
 *   transitions the request to `unknown` and throws `InvalidPaymentConfigError`
 *   before signing a payment, blocking retries.
 * - Once a payment is signed and submitted, response loss transitions the
 *   request to `unknown` and throws `PaymentStateUnknownError`.
 * - Any subsequent retry for a request in `in_flight`, `settled`, or `unknown`
 *   state throws `PaymentRetryBlockedError` before signing a second payment.
 *
 * @param {object} httpClient - x402HTTPClient instance
 * @param {Function} fetchImpl - underlying fetch implementation (e.g. fetchWithTimeout)
 * @param {object} [options] - optional payment config ({ usdcToken, facilitatorUrl })
 */
export function createPaymentFetch(httpClient, fetchImpl, options = {}) {
  const states = new Map();

  async function paymentFetch(url, init = {}) {
    const { paymentRequestKey, ...fetchInit } = init;
    const method = (fetchInit.method ?? 'GET').toUpperCase();
    const requestKey = paymentRequestKey ?? `${method} ${url}`;

    const existing = states.get(requestKey);
    if (
      existing &&
      (existing.state === PAYMENT_STATE.SETTLED ||
        existing.state === PAYMENT_STATE.UNKNOWN ||
        existing.state === PAYMENT_STATE.IN_FLIGHT)
    ) {
      throw new PaymentRetryBlockedError(url, requestKey, existing.state, existing.txHash);
    }

    // 0. Validate configured USDC token and facilitator URL before probing/signing.
    try {
      validatePaymentConfig(options, { url, requestKey });
    } catch (err) {
      states.set(requestKey, {
        state: PAYMENT_STATE.UNKNOWN,
        url,
        txHash: null,
        error: err,
      });
      throw err;
    }

    // 1. Unpaid probe — safe to retry if this throws before a 402 is signed.
    const probe = await fetchImpl(url, fetchInit);
    if (probe.status !== 402) return probe;

    // 2. Parse 402 payment requirements, validate token/facilitator, and sign.
    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => probe.headers.get(name),
      await probe.json().catch(() => undefined)
    );
    try {
      validatePaymentRequirements(paymentRequired, options, { url, requestKey });
    } catch (err) {
      states.set(requestKey, {
        state: PAYMENT_STATE.UNKNOWN,
        url,
        txHash: null,
        error: err,
      });
      throw err;
    }

    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    // 3. Cross the retry boundary: payment is signed and about to be submitted.
    states.set(requestKey, {
      state: PAYMENT_STATE.IN_FLIGHT,
      url,
      txHash: null,
    });

    let paidResponse;
    try {
      paidResponse = await fetchImpl(url, {
        ...fetchInit,
        headers: { ...(fetchInit.headers ?? {}), ...paymentHeaders },
      });
    } catch (err) {
      states.set(requestKey, {
        state: PAYMENT_STATE.UNKNOWN,
        url,
        txHash: null,
        error: err,
      });
      throw new PaymentStateUnknownError(url, requestKey, err);
    }

    const txHash = paidResponse.headers?.get?.('x-payment-transaction') ?? null;
    if (paidResponse.ok || txHash) {
      states.set(requestKey, {
        state: PAYMENT_STATE.SETTLED,
        url,
        txHash,
      });
    } else {
      // Signed payment was transmitted, but the server returned an error without
      // a transaction hash; treat settlement as unknown so retries cannot double-sign.
      states.set(requestKey, {
        state: PAYMENT_STATE.UNKNOWN,
        url,
        txHash: null,
      });
    }

    return paidResponse;
  }

  paymentFetch.getPaymentState = (requestKey) =>
    states.get(requestKey) ?? { state: PAYMENT_STATE.UNPAID, url: null, txHash: null };

  return paymentFetch;
}
