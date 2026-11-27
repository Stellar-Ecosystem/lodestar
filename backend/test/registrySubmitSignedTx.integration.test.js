import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { ContractError } from "../src/lib/ContractError.js";

/**
 * Integration coverage for POST /api/registry/submit-signed-tx.
 *
 * The route is exercised through the real application — the router as it is
 * mounted in `src/index.js`, with the request logger, request context,
 * request ID, JSON body parser, write rate limiter, and error handler in front
 * of it — so regressions in middleware ordering, status codes, or response
 * shapes fail here instead of shipping.
 *
 * Only the contract layer is mocked: no RPC is touched.
 */

// The app validates its environment when it is imported, so the required
// variables are set before the module is loaded. `dotenv` never overrides a
// variable that is already set, so these win over `backend/.env`.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.CONTRACT_ID = "C_INTEGRATION_TEST_CONTRACT";
process.env.SERVER_STELLAR_ADDRESS =
  "GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3";
process.env.SERVER_STELLAR_SECRET =
  "S_INTEGRATION_TEST_SECRET_INTEGRATION_TEST_SECRET_INTEGRATION_";
process.env.STELLAR_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.STELLAR_NETWORK_PASSPHRASE =
  "Test SDF Network ; September 2015";
process.env.FACILITATOR_URL = "https://facilitator.example";
process.env.USDC_CONTRACT_ID = "C_INTEGRATION_TEST_USDC";

vi.mock("../src/lib/contract.js", async () => {
  const { createContractMock } = await import("./helpers/contractMock.js");
  return createContractMock();
});

// The x402 payment middleware is not part of this route — stub it so no
// facilitator call is attempted.
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

beforeAll(async () => {
  ({ app } = await import("../src/index.js"));
  contract = await import("../src/lib/contract.js");
}, 30_000);

beforeEach(() => {
  vi.clearAllMocks();
  contract.validatePreparedRegistrySubmission.mockReset();
  contract.submitSignedRegistryTx.mockReset();
});

describe("POST /api/registry/submit-signed-tx (integration)", () => {
  it("submits a valid signed transaction and returns 200 with JSON body", async () => {
    const txResult = { hash: "abc123def456", id: 42 };
    contract.submitSignedRegistryTx.mockResolvedValue(txResult);

    const res = await request(app)
      .post("/api/registry/submit-signed-tx")
      .send({ signedXdr: "AAAAAgAAAABsignedXdr", submitToken: "tok_valid_123" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ success: true, hash: "abc123def456", id: 42 });
    expect(contract.validatePreparedRegistrySubmission).toHaveBeenCalledWith(
      "tok_valid_123",
      "AAAAAgAAAABsignedXdr",
    );
    expect(contract.submitSignedRegistryTx).toHaveBeenCalledWith(
      "AAAAAgAAAABsignedXdr",
    );
  });

  it("rejects a missing or non-string signedXdr with 400 INVALID_BODY", async () => {
    const res = await request(app)
      .post("/api/registry/submit-signed-tx")
      .send({ submitToken: "tok_valid_123" });

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({
      error: "`signedXdr` is required",
      code: "INVALID_BODY",
    });
    expect(contract.validatePreparedRegistrySubmission).not.toHaveBeenCalled();
    expect(contract.submitSignedRegistryTx).not.toHaveBeenCalled();
  });

  it("rejects a missing or non-string submitToken with 400 INVALID_BODY", async () => {
    const res = await request(app)
      .post("/api/registry/submit-signed-tx")
      .send({ signedXdr: "AAAAAgAAAABsignedXdr", submitToken: 12345 });

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({
      error: "`submitToken` is required",
      code: "INVALID_BODY",
    });
    expect(contract.validatePreparedRegistrySubmission).not.toHaveBeenCalled();
    expect(contract.submitSignedRegistryTx).not.toHaveBeenCalled();
  });

  it("returns 400 when validatePreparedRegistrySubmission throws a ContractError", async () => {
    contract.validatePreparedRegistrySubmission.mockImplementationOnce(() => {
      throw new ContractError("Invalid or expired submit token", "INVALID_SUBMIT_TOKEN");
    });

    const res = await request(app)
      .post("/api/registry/submit-signed-tx")
      .send({ signedXdr: "AAAAAgAAAABsignedXdr", submitToken: "tok_expired" });

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({
      error: "Invalid or expired submit token",
      code: "INVALID_SUBMIT_TOKEN",
    });
    expect(contract.submitSignedRegistryTx).not.toHaveBeenCalled();
  });

  it("returns 504 when submitSignedRegistryTx throws a TRANSACTION_TIMEOUT ContractError", async () => {
    contract.submitSignedRegistryTx.mockRejectedValue(
      new ContractError("Transaction confirmation timed out", "TRANSACTION_TIMEOUT"),
    );

    const res = await request(app)
      .post("/api/registry/submit-signed-tx")
      .send({ signedXdr: "AAAAAgAAAABsignedXdr", submitToken: "tok_valid_123" });

    expect(res.status).toBe(504);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({
      error: "Transaction confirmation timed out",
      code: "TRANSACTION_TIMEOUT",
    });
  });

  it("returns 500 SUBMIT_TX_ERROR when submitSignedRegistryTx throws an unexpected error", async () => {
    contract.submitSignedRegistryTx.mockRejectedValue(new Error("RPC unreachable"));

    const res = await request(app)
      .post("/api/registry/submit-signed-tx")
      .send({ signedXdr: "AAAAAgAAAABsignedXdr", submitToken: "tok_valid_123" });

    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toMatchObject({
      error: "Failed to submit transaction",
      code: "SUBMIT_TX_ERROR",
    });
  });

  it("exercises mounted middleware: propagates X-Request-Id and attaches rate-limit headers", async () => {
    contract.submitSignedRegistryTx.mockResolvedValue({ hash: "tx_mw_1", id: 7 });

    const okRes = await request(app)
      .post("/api/registry/submit-signed-tx")
      .set("X-Request-Id", "integration-submit-ok")
      .send({ signedXdr: "AAAAAgAAAABsignedXdr", submitToken: "tok_valid_123" });

    expect(okRes.status).toBe(200);
    expect(okRes.headers["x-request-id"]).toBe("integration-submit-ok");
    expect(okRes.headers["ratelimit-limit"]).toBeDefined();
    expect(okRes.headers["ratelimit-remaining"]).toBeDefined();

    contract.submitSignedRegistryTx.mockRejectedValue(new Error("RPC unreachable"));

    const errRes = await request(app)
      .post("/api/registry/submit-signed-tx")
      .set("X-Request-Id", "integration-submit-err")
      .send({ signedXdr: "AAAAAgAAAABsignedXdr", submitToken: "tok_valid_123" });

    expect(errRes.status).toBe(500);
    expect(errRes.headers["x-request-id"]).toBe("integration-submit-err");
    expect(errRes.body.requestId).toBe("integration-submit-err");
  });
});
