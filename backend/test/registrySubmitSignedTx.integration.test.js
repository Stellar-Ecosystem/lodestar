import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { ContractError } from "../src/lib/ContractError.js";
import requestIdMiddleware from "../src/lib/requestId.js";

// Mock contract layer only - not the middlewares
const mockValidatePreparedRegistrySubmission = vi.fn();
const mockSubmitSignedRegistryTx = vi.fn();

vi.mock("../src/lib/contract.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    validatePreparedRegistrySubmission: (...args) => mockValidatePreparedRegistrySubmission(...args),
    submitSignedRegistryTx: (...args) => mockSubmitSignedRegistryTx(...args),
  };
});

vi.mock("../src/lib/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import router after mocking
import registryRouter from "../src/routes/registry.js";

function createMountedApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use("/api", registryRouter);
  return app;
}

describe("POST /api/registry/submit-signed-tx integration", () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createMountedApp();
  });

  describe("Happy path", () => {
    it("submits signed transaction successfully and asserts status, body shape, content-type and headers", async () => {
      mockValidatePreparedRegistrySubmission.mockReturnValue({ action: "register" });
      mockSubmitSignedRegistryTx.mockResolvedValue({ hash: "tx-hash-12345", id: 42 });

      const payload = {
        signedXdr: "AAAA_VALID_SIGNED_XDR",
        submitToken: "valid-submit-token-xyz",
      };

      const response = await request(app)
        .post("/api/registry/submit-signed-tx")
        .set("Content-Type", "application/json")
        .send(payload);

      // Status
      expect(response.status).toBe(200);

      // Content-Type header
      expect(response.headers["content-type"]).toMatch(/application\/json/);

      // Body shape
      expect(response.body).toEqual({
        success: true,
        hash: "tx-hash-12345",
        id: 42,
      });

      // Headers set by middleware
      expect(response.headers).toHaveProperty("x-request-id");
      expect(response.headers).toHaveProperty("ratelimit-limit");
      expect(response.headers).toHaveProperty("ratelimit-remaining");

      // Verify contract layer interaction
      expect(mockValidatePreparedRegistrySubmission).toHaveBeenCalledTimes(1);
      expect(mockValidatePreparedRegistrySubmission).toHaveBeenCalledWith(
        payload.submitToken,
        payload.signedXdr,
      );
      expect(mockSubmitSignedRegistryTx).toHaveBeenCalledTimes(1);
      expect(mockSubmitSignedRegistryTx).toHaveBeenCalledWith(payload.signedXdr);
    });
  });

  describe("Failure modes", () => {
    it("returns 400 with INVALID_BODY when signedXdr is missing", async () => {
      const response = await request(app)
        .post("/api/registry/submit-signed-tx")
        .send({ submitToken: "some-token" });

      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(response.body).toEqual({
        error: "`signedXdr` is required",
        code: "INVALID_BODY",
      });

      expect(mockValidatePreparedRegistrySubmission).not.toHaveBeenCalled();
      expect(mockSubmitSignedRegistryTx).not.toHaveBeenCalled();
    });

    it("returns 400 with INVALID_BODY when submitToken is missing", async () => {
      const response = await request(app)
        .post("/api/registry/submit-signed-tx")
        .send({ signedXdr: "AAAA_SIGNED_XDR" });

      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(response.body).toEqual({
        error: "`submitToken` is required",
        code: "INVALID_BODY",
      });

      expect(mockValidatePreparedRegistrySubmission).not.toHaveBeenCalled();
      expect(mockSubmitSignedRegistryTx).not.toHaveBeenCalled();
    });

    it("returns 504 when contract layer throws TRANSACTION_TIMEOUT ContractError", async () => {
      mockValidatePreparedRegistrySubmission.mockReturnValue({ action: "register" });
      mockSubmitSignedRegistryTx.mockRejectedValue(
        new ContractError("Transaction confirmation timed out", "TRANSACTION_TIMEOUT"),
      );

      const response = await request(app)
        .post("/api/registry/submit-signed-tx")
        .send({
          signedXdr: "AAAA_SIGNED_XDR",
          submitToken: "submit-token-timeout",
        });

      expect(response.status).toBe(504);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(response.body).toEqual({
        error: "Transaction confirmation timed out",
        code: "TRANSACTION_TIMEOUT",
      });
    });

    it("returns 400 when contract layer throws non-timeout ContractError", async () => {
      mockValidatePreparedRegistrySubmission.mockReturnValue({ action: "register" });
      mockSubmitSignedRegistryTx.mockRejectedValue(
        new ContractError("Service already exists on-chain", "ALREADY_EXISTS"),
      );

      const response = await request(app)
        .post("/api/registry/submit-signed-tx")
        .send({
          signedXdr: "AAAA_SIGNED_XDR",
          submitToken: "submit-token-exists",
        });

      expect(response.status).toBe(400);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(response.body).toEqual({
        error: "Service already exists on-chain",
        code: "ALREADY_EXISTS",
      });
    });

    it("returns 500 when contract layer throws an unexpected error", async () => {
      mockValidatePreparedRegistrySubmission.mockReturnValue({ action: "register" });
      mockSubmitSignedRegistryTx.mockRejectedValue(new Error("RPC node unavailable"));

      const response = await request(app)
        .post("/api/registry/submit-signed-tx")
        .send({
          signedXdr: "AAAA_SIGNED_XDR",
          submitToken: "submit-token-crash",
        });

      expect(response.status).toBe(500);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
      expect(response.body).toEqual({
        error: "Failed to submit transaction",
        code: "SUBMIT_TX_ERROR",
      });
    });
  });

  describe("Middleware ordering and rate limiting", () => {
    it("exercises rate limiter middleware and does not bypass it", async () => {
      // Send multiple requests and assert that rate-limiting headers update
      mockValidatePreparedRegistrySubmission.mockReturnValue({ action: "register" });
      mockSubmitSignedRegistryTx.mockResolvedValue({ hash: "hash-rate-test", id: 1 });

      const res1 = await request(app)
        .post("/api/registry/submit-signed-tx")
        .send({ signedXdr: "AAAA", submitToken: "tok" });

      expect(res1.status).toBe(200);
      expect(res1.headers).toHaveProperty("ratelimit-limit");
      expect(res1.headers).toHaveProperty("ratelimit-remaining");

      const limit = Number(res1.headers["ratelimit-limit"]);
      const remaining1 = Number(res1.headers["ratelimit-remaining"]);
      expect(limit).toBeGreaterThan(0);
      expect(remaining1).toBeLessThan(limit);

      const res2 = await request(app)
        .post("/api/registry/submit-signed-tx")
        .send({ signedXdr: "AAAA", submitToken: "tok" });

      expect(res2.status).toBe(200);
      const remaining2 = Number(res2.headers["ratelimit-remaining"]);
      expect(remaining2).toBe(remaining1 - 1);
    });

    it("exercises json body parsing middleware before route handler", async () => {
      // Verifies express.json() is active in the middleware pipeline
      const response = await request(app)
        .post("/api/registry/submit-signed-tx")
        .set("Content-Type", "application/json")
        .send("{ malformed-json");

      expect(response.status).toBe(400);
      expect(mockSubmitSignedRegistryTx).not.toHaveBeenCalled();
    });
  });
});
