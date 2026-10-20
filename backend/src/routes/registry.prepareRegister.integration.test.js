import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockBuildUnsignedRegistryTx = vi.fn();
const mockGetCurrentLedgerSequence = vi.fn();

vi.mock("../lib/contract.js", () => ({
  listServices: vi.fn(),
  listServicesByProvider: vi.fn(),
  getService: vi.fn(),
  getServiceCount: vi.fn(),
  deactivateServiceOnChain: vi.fn(),
  updateReputation: vi.fn(),
  isAllowedReputationAgent: vi.fn(),
  buildUnsignedRegistryTx: (...args) => mockBuildUnsignedRegistryTx(...args),
  validatePreparedRegistrySubmission: vi.fn(),
  submitSignedRegistryTx: vi.fn(),
  SERVICE_MAX_TTL: 3_110_400,
  SERVICE_TTL_WARNING_LEDGERS: 311_040,
}));

vi.mock("../lib/stellar.js", () => ({
  getCurrentLedgerSequence: (...args) => mockGetCurrentLedgerSequence(...args),
}));

vi.mock("../lib/reputationHistory.js", () => ({
  getReputationHistory: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// NOTE: Unlike unit tests in registry.test.js, ../middleware/rateLimiter.js is NOT mocked here.
// This integration test verifies that the real writeRateLimiter middleware correctly enforces
// the route's ceiling on POST /api/registry/prepare-register and returns Retry-After headers.

let app;
let PREPARE_REGISTER_RATE_LIMIT_MAX;
let PREPARE_REGISTER_RATE_LIMIT_WINDOW_MS;

const VALID_STELLAR_ADDRESS =
  "GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3";
const VALID_PAYLOAD = {
  name: "Integration Test Service",
  description: "A test service for verifying the prepare-register rate limiter",
  endpoint: "https://service.example.com",
  priceUsdc: "0.01",
  category: "ai",
  providerAddress: VALID_STELLAR_ADDRESS,
};

beforeAll(async () => {
  const registryModule = await import("./registry.js");
  const router = registryModule.default;
  PREPARE_REGISTER_RATE_LIMIT_MAX =
    registryModule.PREPARE_REGISTER_RATE_LIMIT_MAX;
  PREPARE_REGISTER_RATE_LIMIT_WINDOW_MS =
    registryModule.PREPARE_REGISTER_RATE_LIMIT_WINDOW_MS;

  app = express();
  app.use(express.json());
  app.use("/api", router);
});

describe("POST /api/registry/prepare-register rate limiting integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports a deliberate rate limit ceiling configuration", () => {
    expect(PREPARE_REGISTER_RATE_LIMIT_MAX).toBe(5);
    expect(PREPARE_REGISTER_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it("allows requests up to the ceiling, then fires 429 with Retry-After and blocks RPC calls", async () => {
    mockBuildUnsignedRegistryTx.mockResolvedValue({
      xdr: "AAAA_MOCK_TRANSACTION_XDR",
      submitToken: "mock-submit-token-xyz",
    });

    // 1. Send requests up to the allowed ceiling (PREPARE_REGISTER_RATE_LIMIT_MAX = 5)
    for (let i = 1; i <= PREPARE_REGISTER_RATE_LIMIT_MAX; i++) {
      const res = await request(app)
        .post("/api/registry/prepare-register")
        .send(VALID_PAYLOAD);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        xdr: "AAAA_MOCK_TRANSACTION_XDR",
        submitToken: "mock-submit-token-xyz",
      });
    }

    expect(mockBuildUnsignedRegistryTx).toHaveBeenCalledTimes(
      PREPARE_REGISTER_RATE_LIMIT_MAX,
    );

    // 2. The next request (ceiling + 1) must be throttled by the rate limiter
    const limitedRes = await request(app)
      .post("/api/registry/prepare-register")
      .send(VALID_PAYLOAD);

    // Assert 429 response status and body
    expect(limitedRes.status).toBe(429);
    expect(limitedRes.body).toEqual({
      error: "Too many requests. Please slow down and try again later.",
      code: "RATE_LIMITED",
      retryAfterMs: PREPARE_REGISTER_RATE_LIMIT_WINDOW_MS,
    });

    // Assert Retry-After header is present and carries positive seconds
    expect(limitedRes.headers["retry-after"]).toBeDefined();
    const retryAfterSec = Number(limitedRes.headers["retry-after"]);
    expect(Number.isFinite(retryAfterSec)).toBe(true);
    expect(retryAfterSec).toBeGreaterThan(0);
    expect(retryAfterSec).toBeLessThanOrEqual(
      PREPARE_REGISTER_RATE_LIMIT_WINDOW_MS / 1000,
    );

    // Assert the route handler was NOT executed for the 6th call, protecting upstream RPC
    expect(mockBuildUnsignedRegistryTx).toHaveBeenCalledTimes(
      PREPARE_REGISTER_RATE_LIMIT_MAX,
    );
  });
});
