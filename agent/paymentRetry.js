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

export function isPaymentBoundaryError(err) {
  return (
    err instanceof PaymentStateUnknownError ||
    err instanceof PaymentRetryBlockedError ||
    err?.code === 'PAYMENT_STATE_UNKNOWN' ||
    err?.code === 'PAYMENT_RETRY_BLOCKED'
  );
}

/**
 * Wrap an x402HTTPClient's 402-payment flow with an explicit retry boundary.
 *
 * - Pre-payment probe failures leave the request unpaid and safe to retry.
 * - Once a payment is signed and submitted, response loss transitions the
 *   request to `unknown` and throws `PaymentStateUnknownError`.
 * - Any subsequent retry for a request in `in_flight`, `settled`, or `unknown`
 *   state throws `PaymentRetryBlockedError` before signing a second payment.
 *
 * @param {object} httpClient - x402HTTPClient instance
 * @param {Function} fetchImpl - underlying fetch implementation (e.g. fetchWithTimeout)
 */
export function createPaymentFetch(httpClient, fetchImpl) {
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

    // 1. Unpaid probe — safe to retry if this throws before a 402 is signed.
    const probe = await fetchImpl(url, fetchInit);
    if (probe.status !== 402) return probe;

    // 2. Parse 402 payment requirements and sign the payment payload.
    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => probe.headers.get(name),
      await probe.json().catch(() => undefined)
    );
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
