import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { ContractError } from "../src/lib/ContractError.js";

/**
 * Integration coverage for POST /api/registry/submit-signed-tx (#668).
 *
 * Exercises the full Express middleware + route handler chain mounted in
 * `src/index.js` (request logger, request context, CORS, request ID, JSON body
 * parser with size limit, write rate limiter, and error handler) with a mocked
 * contract layer so tests run in CI without a live Soroban node.
 */

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
process.env.RATE_LIMIT_MAX = "1000";

vi.mock("../src/lib/contract.js", async () => {
  const { createContractMock } = await import("./helpers/contractMock.js");
  return createContractMock();
});

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
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/registry/submit-signed-tx (integration, #668)", () => {
  const VALID_PAYLOAD = {
    signedXdr: "AAAAAgAAAABvalidSignedXdrPayload==",
    submitToken: "11111111-2222-3333-4444-555555555555",
  };

  it("submits a valid signed transaction and returns 200 with hash, id, and headers", async () => {
    contract.validatePreparedRegistrySubmission.mockReturnValue(undefined);
    contract.submitSignedRegistryTx.mockResolvedValue({
      hash: "txhash_integration_abc123",
      id: 42,
    });

    const res = await request(app)
      .post("/api/registry/submit-signed-tx")
      .set("X-Request-Id", "integration-submit-happy-1")
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["x-request-id"]).toBe("integration-submit-happy-1");
    expect(res.body).toEqual({
      success: true,
      hash: "txhash_integration_abc123",
      id: 42,
    });
    expect(contract.validatePreparedRegistrySubmission).toHaveBeenCalledWith(
      VALID_PAYLOAD.submitToken,
      VALID_PAYLOAD.signedXdr,
    );
    expect(contract.submitSignedRegistryTx).toHaveBeenCalledWith(
      VALID_PAYLOAD.signedXdr,
    );
  });

  it.each([
    ["missing signedXdr", { submitToken: VALID_PAYLOAD.submitToken }, "`signedXdr` is required"],
    ["non-string signedXdr", { signedXdr: 12345, submitToken: VALID_PAYLOAD.submitToken }, "`signedXdr` is required"],
    ["missing submitToken", { signedXdr: VALID_PAYLOAD.signedXdr }, "`submitToken` is required"],
    ["non-string submitToken", { signedXdr: VALID_PAYLOAD.signedXdr, submitToken: {} }, "`submitToken` is required"],
  ])(
    "rejects %s with 400 INVALID_BODY before calling the contract layer",
    async (_case, body, expectedMessage) => {
      const res = await request(app)
        .post("/api/registry/submit-signed-tx")
        .send(body);

      expect(res.status).toBe(400);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.body).toMatchObject({
        error: expectedMessage,
        code: "INVALID_BODY",
      });
      expect(contract.validatePreparedRegistrySubmission).not.toHaveBeenCalled();
      expect(contract.submitSignedRegistryTx).not.toHaveBeenCalled();
    },
  );

  it("returns 400 when validatePreparedRegistrySubmission rejects an invalid or expired token", async () => {
    contract.validatePreparedRegistrySubmission.mockImplementation(() => {
      throw new ContractError(
        "Submit token has expired or is invalid",
        "INVALID_SUBMIT_TOKEN",
      );
    });

    const res = await request(app)
      .post("/api/registry/submit-signed-tx")
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "Submit token has expired or is invalid",
      code: "INVALID_SUBMIT_TOKEN",
    });
    expect(contract.submitSignedRegistryTx).not.toHaveBeenCalled();
  });

  it("returns 400 with the contract error code when on-chain submission fails with a ContractError", async () => {
    contract.validatePreparedRegistrySubmission.mockReturnValue(undefined);
    contract.submitSignedRegistryTx.mockRejectedValue(
      new ContractError(
        "Active service with same provider and endpoint already exists",
        "DUPLICATE_SERVICE",
      ),
    );

    const res = await request(app)
      .post("/api/registry/submit-signed-tx")
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "Active service with same provider and endpoint already exists",
      code: "DUPLICATE_SERVICE",
    });
  });

  it("returns 504 TRANSACTION_TIMEOUT when transaction confirmation polling times out", async () => {
    contract.validatePreparedRegistrySubmission.mockReturnValue(undefined);
    contract.submitSignedRegistryTx.mockRejectedValue(
      new ContractError(
        "Transaction not confirmed after polling: txhash_timeout",
        "TRANSACTION_TIMEOUT",
      ),
    );

    const res = await request(app)
      .post("/api/registry/submit-signed-tx")
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({
      error: "Transaction not confirmed after polling: txhash_timeout",
      code: "TRANSACTION_TIMEOUT",
    });
  });

  it("returns 500 SUBMIT_TX_ERROR and preserves requestId on unexpected upstream failure", async () => {
    contract.validatePreparedRegistrySubmission.mockReturnValue(undefined);
    contract.submitSignedRegistryTx.mockRejectedValue(
      new Error("Soroban RPC socket hang up"),
    );

    const res = await request(app)
      .post("/api/registry/submit-signed-tx")
      .set("X-Request-Id", "integration-submit-err-1")
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["x-request-id"]).toBe("integration-submit-err-1");
    expect(res.body).toEqual({
      error: "Failed to submit transaction",
      code: "SUBMIT_TX_ERROR",
      requestId: "integration-submit-err-1",
    });
  });

  it("enforces the mounted JSON body size limit middleware with 413 PAYLOAD_TOO_LARGE", async () => {
    const oversizedPayload = {
      signedXdr: "A".repeat(200_000),
      submitToken: VALID_PAYLOAD.submitToken,
    };

    const res = await request(app)
      .post("/api/registry/submit-signed-tx")
      .send(oversizedPayload);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
    expect(contract.validatePreparedRegistrySubmission).not.toHaveBeenCalled();
    expect(contract.submitSignedRegistryTx).not.toHaveBeenCalled();
  });
});
