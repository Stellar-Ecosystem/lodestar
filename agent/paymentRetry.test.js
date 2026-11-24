import { describe, it, expect, vi } from 'vitest';
import {
  createPaymentFetch,
  PAYMENT_STATE,
  PaymentStateUnknownError,
  PaymentRetryBlockedError,
} from './paymentRetry.js';

function makeResponse({ ok = true, status = 200, headers = {}, body = {} } = {}) {
  return {
    ok,
    status,
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null,
    },
    json: () => Promise.resolve(body),
  };
}

function makeMockHttpClient() {
  return {
    getPaymentRequiredResponse: vi.fn((_getHeader, body) => ({ requirements: body })),
    createPaymentPayload: vi.fn(async (req) => ({ signed: true, req })),
    encodePaymentSignatureHeader: vi.fn(() => ({ 'X-PAYMENT': 'signed-payload' })),
  };
}

describe('createPaymentFetch — 402 payment retry boundary', () => {
  it('passes through non-402 responses without signing a payment', async () => {
    const httpClient = makeMockHttpClient();
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse({ status: 200, body: { ok: true } }));
    const paymentFetch = createPaymentFetch(httpClient, fetchImpl);

    const res = await paymentFetch('https://api.example.com/weather');

    expect(res.status).toBe(200);
    expect(httpClient.createPaymentPayload).not.toHaveBeenCalled();
    expect(paymentFetch.getPaymentState('GET https://api.example.com/weather').state).toBe(
      PAYMENT_STATE.UNPAID
    );
  });

  it('allows retry when the initial unpaid probe fails before 402 signing', async () => {
    const httpClient = makeMockHttpClient();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient probe timeout'))
      .mockResolvedValueOnce(makeResponse({ ok: false, status: 402, body: { amount: '100' } }))
      .mockResolvedValueOnce(
        makeResponse({
          ok: true,
          status: 200,
          headers: { 'x-payment-transaction': 'tx-abc' },
        })
      );
    const paymentFetch = createPaymentFetch(httpClient, fetchImpl);

    await expect(paymentFetch('https://api.example.com/weather')).rejects.toThrow(
      'transient probe timeout'
    );
    expect(httpClient.createPaymentPayload).not.toHaveBeenCalled();

    const res = await paymentFetch('https://api.example.com/weather');
    expect(res.ok).toBe(true);
    expect(httpClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(paymentFetch.getPaymentState('GET https://api.example.com/weather')).toMatchObject({
      state: PAYMENT_STATE.SETTLED,
      txHash: 'tx-abc',
    });
  });

  it('never signs a second payment when retrying an already settled request', async () => {
    const httpClient = makeMockHttpClient();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ ok: false, status: 402, body: { amount: '100' } }))
      .mockResolvedValueOnce(
        makeResponse({
          ok: true,
          status: 200,
          headers: { 'x-payment-transaction': 'tx-settled-1' },
        })
      );
    const paymentFetch = createPaymentFetch(httpClient, fetchImpl);

    const first = await paymentFetch('https://api.example.com/weather');
    expect(first.ok).toBe(true);
    expect(httpClient.createPaymentPayload).toHaveBeenCalledTimes(1);

    await expect(paymentFetch('https://api.example.com/weather')).rejects.toThrow(
      PaymentRetryBlockedError
    );

    // Must never probe or sign a second payment
    expect(httpClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('transitions to explicit unknown state on response loss after payment submission and blocks retries', async () => {
    const httpClient = makeMockHttpClient();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ ok: false, status: 402, body: { amount: '100' } }))
      .mockRejectedValueOnce(new Error('socket hang up after settlement'));
    const paymentFetch = createPaymentFetch(httpClient, fetchImpl);

    let caught;
    try {
      await paymentFetch('https://api.example.com/weather');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PaymentStateUnknownError);
    expect(caught.code).toBe('PAYMENT_STATE_UNKNOWN');
    expect(caught.paymentState).toBe(PAYMENT_STATE.UNKNOWN);
    expect(caught.retryable).toBe(false);
    expect(httpClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(paymentFetch.getPaymentState('GET https://api.example.com/weather')).toMatchObject({
      state: PAYMENT_STATE.UNKNOWN,
    });

    // Subsequent retry must be blocked without signing a second payment
    await expect(paymentFetch('https://api.example.com/weather')).rejects.toMatchObject({
      name: 'PaymentRetryBlockedError',
      code: 'PAYMENT_RETRY_BLOCKED',
      paymentState: PAYMENT_STATE.UNKNOWN,
      retryable: false,
    });
    expect(httpClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  it('blocks concurrent duplicate payment submission while a payment is in flight', async () => {
    const httpClient = makeMockHttpClient();
    let resolvePaid;
    const paidPromise = new Promise((resolve) => {
      resolvePaid = resolve;
    });
    let markPaidStarted;
    const paidStarted = new Promise((resolve) => {
      markPaidStarted = resolve;
    });

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ ok: false, status: 402, body: { amount: '100' } }))
      .mockImplementationOnce(() => {
        markPaidStarted();
        return paidPromise;
      });
    const paymentFetch = createPaymentFetch(httpClient, fetchImpl);

    const firstCall = paymentFetch('https://api.example.com/weather');
    await paidStarted;

    await expect(paymentFetch('https://api.example.com/weather')).rejects.toMatchObject({
      name: 'PaymentRetryBlockedError',
      paymentState: PAYMENT_STATE.IN_FLIGHT,
    });
    expect(httpClient.createPaymentPayload).toHaveBeenCalledTimes(1);

    resolvePaid(
      makeResponse({ ok: true, status: 200, headers: { 'x-payment-transaction': 'tx-in-flight' } })
    );
    const res = await firstCall;
    expect(res.ok).toBe(true);
  });

  it('marks non-ok paid response without txHash as unknown so retries do not double-sign', async () => {
    const httpClient = makeMockHttpClient();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({ ok: false, status: 402, body: { amount: '100' } }))
      .mockResolvedValueOnce(makeResponse({ ok: false, status: 502 }));
    const paymentFetch = createPaymentFetch(httpClient, fetchImpl);

    const res = await paymentFetch('https://api.example.com/weather');
    expect(res.status).toBe(502);
    expect(paymentFetch.getPaymentState('GET https://api.example.com/weather').state).toBe(
      PAYMENT_STATE.UNKNOWN
    );

    await expect(paymentFetch('https://api.example.com/weather')).rejects.toThrow(
      PaymentRetryBlockedError
    );
    expect(httpClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });
});
