import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

/**
 * Integration coverage for `POST /registry/submit-signed-tx` (#668).
 *
 * The route is exercised through the real application mounted in
 * `src/index.js` — request id middleware, JSON body parser, the per-route
 * write limiter and the terminal error handler included — so a change in
 * middleware ordering shows up here and not only in the handler unit tests.
 * Only the contract layer is replaced: `validatePreparedRegistrySubmission`
 * and `submitSignedRegistryTx` stand in for the on-chain submission, so no RPC
 * call is made.
 */

// The app validates its environment on import, so every required variable is
// set before the module is loaded. `dotenv` never overrides a value that is
// already present, so these win over `backend/.env`.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.CONTRACT_ID = "C_INTEGRATION_TEST_CONTRACT";
process.env.SERVER_STELLAR_ADDRESS =
  "GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3";
process.env.SERVER_STELLAR_SECRET =
  "S_INTEGRATION_TEST_SECRET_INTEGRATION_TEST_SECRET_INTEGRATION_";
process.env.STELLAR_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.STELLAR_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
process.env.FACILITATOR_URL = "https://facilitator.example";
process.env.USDC_CONTRACT_ID = "C_INTEGRATION_TEST_USDC";
// The write limiter is real middleware on this route; raise its ceiling so the
// assertions below are not turned into 429s by the number of cases in the file.
process.env.RATE_LIMIT_MAX = "1000";
// A small ceiling makes the body-size case cheap to express: the parser rejects
// the payload before the route is reached.
process.env.JSON_BODY_LIMIT = "1kb";

vi.mock("../src/lib/contract.js", async () => {
  const { createContractMock } = await import("./helpers/contractMock.js");
  return createContractMock();
});

vi.mock("../src/lib/activityFeed.js", async () => {
  const actual = await vi.importActual("../src/lib/activityFeed.js");
  return {
    ...actual,
    recordActivity: vi.fn(),
    getActivityFeed: vi.fn(() => []),
  };
});

// x402 is stubbed so importing the app does not build a facilitator client.
// None of the routes used here are payment-gated.
vi.mock("@x402/express", () => ({
  paymentMiddlewareFromConfig: () => (_req, _res, next) => next(),
}));
vi.mock("@x402/core/server", () => ({
  HTTPFacilitatorClient: vi.fn(() => ({})),
}));
vi.mock("@x402/stellar/exact/server", () => ({
  ExactStellarScheme: vi.fn(() => ({})),
}));
vi.mock("@x402/core/client", () => ({
  x402Client: vi.fn(() => ({ register: vi.fn() })),
  x402HTTPClient: vi.fn(() => ({ fetchWithTx: vi.fn() })),
}));
vi.mock("@x402/stellar", () => ({ createEd25519Signer: vi.fn() }));
vi.mock("@x402/stellar/exact/client", () => ({ ExactStellarScheme: vi.fn() }));

let app;
let contract;
let ContractError;

const ENDPOINT = "/api/registry/submit-signed-tx";
const VALID_BODY = {
  signedXdr: "AAAA_SIGNED_XDR",
  submitToken: "submit-token-integration",
};

beforeAll(async () => {
  ({ app } = await import("../src/index.js"));
  contract = await import("../src/lib/contract.js");
  ({ ContractError } = await import("../src/lib/ContractError.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/registry/submit-signed-tx (mounted app)", () => {
  it("submits a wallet-signed transaction and returns the hash and id", async () => {
    contract.validatePreparedRegistrySubmission.mockReturnValueOnce({
      action: "register",
    });
    contract.submitSignedRegistryTx.mockResolvedValueOnce({
      hash: "abc123",
      id: 12,
    });

    const res = await request(app).post(ENDPOINT).send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ success: true, hash: "abc123", id: 12 });
    expect(contract.validatePreparedRegistrySubmission).toHaveBeenCalledWith(
      VALID_BODY.submitToken,
      VALID_BODY.signedXdr,
    );
    expect(contract.submitSignedRegistryTx).toHaveBeenCalledWith(
      VALID_BODY.signedXdr,
    );
  });

  it("propagates the request id the client sent, so a submission can be traced", async () => {
    contract.validatePreparedRegistrySubmission.mockReturnValueOnce({
      action: "register",
    });
    contract.submitSignedRegistryTx.mockResolvedValueOnce({
      hash: "trace-me",
      id: 3,
    });

    const res = await request(app)
      .post(ENDPOINT)
      .set("X-Request-Id", "req-integration-1")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBe("req-integration-1");
  });

  it("rejects a body without signedXdr before touching the contract layer", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ submitToken: "submit-token-integration" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_BODY");
    expect(contract.validatePreparedRegistrySubmission).not.toHaveBeenCalled();
    expect(contract.submitSignedRegistryTx).not.toHaveBeenCalled();
  });

  it("rejects a body without submitToken before touching the contract layer", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ signedXdr: "AAAA_SIGNED_XDR" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_BODY");
    expect(contract.submitSignedRegistryTx).not.toHaveBeenCalled();
  });

  it("rejects a non-string signedXdr instead of passing it to the contract layer", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .send({ signedXdr: { raw: "AAAA_SIGNED_XDR" }, submitToken: "t" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_BODY");
    expect(contract.validatePreparedRegistrySubmission).not.toHaveBeenCalled();
  });

  it("maps a rejected preparation token to 400 with the contract error code", async () => {
    contract.validatePreparedRegistrySubmission.mockImplementationOnce(() => {
      throw new ContractError(
        "Prepared submission token has expired",
        "SUBMIT_TOKEN_EXPIRED",
      );
    });

    const res = await request(app).post(ENDPOINT).send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "Prepared submission token has expired",
      code: "SUBMIT_TOKEN_EXPIRED",
    });
    // The request context middleware annotates every response, so the caller
    // can quote an id when reporting the rejection.
    expect(res.body.requestId).toBeTruthy();
    expect(contract.submitSignedRegistryTx).not.toHaveBeenCalled();
  });

  it("answers 504 when the submission times out upstream", async () => {
    contract.validatePreparedRegistrySubmission.mockReturnValueOnce({
      action: "register",
    });
    contract.submitSignedRegistryTx.mockRejectedValueOnce(
      new ContractError(
        "Transaction confirmation timed out",
        "TRANSACTION_TIMEOUT",
      ),
    );

    const res = await request(app).post(ENDPOINT).send(VALID_BODY);

    expect(res.status).toBe(504);
    expect(res.body.code).toBe("TRANSACTION_TIMEOUT");
  });

  it("answers 500 with a stable code when the submission fails unexpectedly", async () => {
    contract.validatePreparedRegistrySubmission.mockReturnValueOnce({
      action: "register",
    });
    contract.submitSignedRegistryTx.mockRejectedValueOnce(
      new Error("socket hang up"),
    );

    const res = await request(app).post(ENDPOINT).send(VALID_BODY);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: "Failed to submit transaction",
      code: "SUBMIT_TX_ERROR",
    });
    expect(res.body.requestId).toBeTruthy();
    // The upstream message is not leaked to the caller.
    expect(JSON.stringify(res.body)).not.toContain("socket hang up");
  });

  it("rejects an oversized body with 413 before the route handler runs", async () => {
    const oversized = {
      ...VALID_BODY,
      padding: "x".repeat(4 * 1024),
    };

    const res = await request(app).post(ENDPOINT).send(oversized);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
    expect(contract.validatePreparedRegistrySubmission).not.toHaveBeenCalled();
    expect(contract.submitSignedRegistryTx).not.toHaveBeenCalled();
  });
});
