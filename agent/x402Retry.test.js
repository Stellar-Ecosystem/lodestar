/**
 * The agent's x402 client from a clean environment (#1277): a legitimate 402 challenge, one
 * signed payment, and the response lost after settlement.
 *
 * Everything is a deterministic fixture: the x402 library is replaced by a recorder and
 * `fetch` by a script, so no network is touched and no funds can move.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const x402 = vi.hoisted(() => ({
  getPaymentRequiredResponse: vi.fn(),
  createPaymentPayload: vi.fn(),
  encodePaymentSignatureHeader: vi.fn(),
}));

vi.mock('dotenv/config', () => ({}));
vi.mock('pino', () => ({
  default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@stellar/stellar-sdk', () => ({
  default: { Keypair: { fromSecret: () => ({ publicKey: () => 'GAGENT' }) } },
}));
vi.mock('@x402/core/client', () => ({
  x402Client: class { register() { return this; } },
  x402HTTPClient: class {
    getPaymentRequiredResponse(...args) { return x402.getPaymentRequiredResponse(...args); }
    createPaymentPayload(...args) { return x402.createPaymentPayload(...args); }
    encodePaymentSignatureHeader(...args) { return x402.encodePaymentSignatureHeader(...args); }
  },
}));
vi.mock('@x402/stellar', () => ({ createEd25519Signer: () => ({}) }));
vi.mock('@x402/stellar/exact/client', () => ({ ExactStellarScheme: class {} }));

process.env.AGENT_STELLAR_SECRET = 'STEST0000000000000000000000000000000000000000000000000000';
process.env.STELLAR_RPC_URL = 'https://mock-rpc.example.com';
process.env.LODESTAR_API_URL = 'http://localhost:9999';

const { buildHttpClient } = await import('./agent.js');

const URL_UNDER_TEST = 'https://api.example.com/weather';
const CHALLENGE = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'stellar:testnet', amount: '10000' }] };
const PAYLOAD = { signed: 'payload-1' };
const PAYMENT_HEADER = { 'PAYMENT-SIGNATURE': 'signed-header-1' };

function reply(status, body = {}, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name] ?? null },
    json: () => Promise.resolve(body),
  };
}

let fetchMock;

beforeEach(() => {
  x402.getPaymentRequiredResponse.mockReset().mockReturnValue(CHALLENGE);
  x402.createPaymentPayload.mockReset().mockResolvedValue(PAYLOAD);
  x402.encodePaymentSignatureHeader.mockReset().mockReturnValue(PAYMENT_HEADER);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agent x402 client: a legitimate 402 challenge', () => {
  it('pays once and returns the verified service result', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(402, { error: 'payment required' }))
      .mockResolvedValueOnce(reply(200, { forecast: 'sunny' }, { 'x-payment-transaction': 'txhash-1' }));

    const response = await buildHttpClient().fetch(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ forecast: 'sunny' });
    expect(response.headers.get('x-payment-transaction')).toBe('txhash-1');
    expect(x402.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(x402.createPaymentPayload).toHaveBeenCalledWith(CHALLENGE);
    expect(x402.encodePaymentSignatureHeader).toHaveBeenCalledTimes(1);
    expect(x402.encodePaymentSignatureHeader).toHaveBeenCalledWith(PAYLOAD);
  });

  it('sends the first request unsigned and the retry with the payment header', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(402))
      .mockResolvedValueOnce(reply(200));

    await buildHttpClient().fetch(URL_UNDER_TEST, { headers: { accept: 'application/json' } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0];
    const [retryUrl, retryInit] = fetchMock.mock.calls[1];
    expect(firstUrl).toBe(URL_UNDER_TEST);
    expect(firstInit.headers).toEqual({ accept: 'application/json' });
    expect(retryUrl).toBe(URL_UNDER_TEST);
    expect(retryInit.headers).toEqual({ accept: 'application/json', ...PAYMENT_HEADER });
  });

  it('reads the challenge from the 402 response headers and body', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(402, { error: 'pay' }, { 'PAYMENT-REQUIRED': 'challenge-header' }))
      .mockResolvedValueOnce(reply(200));

    await buildHttpClient().fetch(URL_UNDER_TEST);

    const [headerReader, body] = x402.getPaymentRequiredResponse.mock.calls[0];
    expect(headerReader('PAYMENT-REQUIRED')).toBe('challenge-header');
    expect(body).toEqual({ error: 'pay' });
  });

  it('does not sign anything when the service answers without a challenge', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { forecast: 'free' }));

    const response = await buildHttpClient().fetch(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(x402.createPaymentPayload).not.toHaveBeenCalled();
    expect(x402.encodePaymentSignatureHeader).not.toHaveBeenCalled();
  });

  it('does not sign anything for an error that is not a payment challenge', async () => {
    fetchMock.mockResolvedValueOnce(reply(500));

    const response = await buildHttpClient().fetch(URL_UNDER_TEST);

    expect(response.status).toBe(500);
    expect(x402.createPaymentPayload).not.toHaveBeenCalled();
  });
});

describe('agent x402 client: the response is lost after settlement', () => {
  it('surfaces the failure and does not sign or send a second payment', async () => {
    // The paid retry reaches the service and settles, but the reply never comes back.
    fetchMock
      .mockResolvedValueOnce(reply(402))
      .mockRejectedValueOnce(new Error('socket hang up'));

    await expect(buildHttpClient().fetch(URL_UNDER_TEST)).rejects.toThrow('socket hang up');

    expect(x402.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(x402.encodePaymentSignatureHeader).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const paidRequests = fetchMock.mock.calls.filter(([, init]) => init?.headers?.['PAYMENT-SIGNATURE']);
    expect(paidRequests).toHaveLength(1);
  });

  it('does not loop when the paid retry is answered with another 402', async () => {
    // A service that keeps challenging must not drain the agent with repeated payments.
    fetchMock
      .mockResolvedValueOnce(reply(402))
      .mockResolvedValueOnce(reply(402));

    const response = await buildHttpClient().fetch(URL_UNDER_TEST);

    expect(response.status).toBe(402);
    expect(x402.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('signs nothing when the first request is the one that is lost', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));

    await expect(buildHttpClient().fetch(URL_UNDER_TEST)).rejects.toThrow('connect ETIMEDOUT');

    expect(x402.createPaymentPayload).not.toHaveBeenCalled();
  });

  it('signs nothing when the challenge cannot be read', async () => {
    x402.getPaymentRequiredResponse.mockImplementation(() => {
      throw new Error('malformed challenge');
    });
    fetchMock.mockResolvedValueOnce(reply(402));

    await expect(buildHttpClient().fetch(URL_UNDER_TEST)).rejects.toThrow('malformed challenge');

    expect(x402.createPaymentPayload).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
