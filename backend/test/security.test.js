import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Bypass x402 payment middleware and facilitator client in tests
vi.mock("@x402/express", () => ({
  paymentMiddlewareFromConfig: () => (_req, _res, next) => next(),
}));

vi.mock("@x402/core/server", () => ({
  HTTPFacilitatorClient: vi.fn(() => ({})),
}));

vi.mock("@x402/stellar/exact/server", () => ({
  ExactStellarScheme: vi.fn(() => ({})),
}));

// Mock dependencies required by index.js imports
const mockLoggerInstance = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLoggerInstance),
  levels: {
    values: { fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10 },
    labels: { 10: "trace", 20: "debug", 30: "info", 40: "warn", 50: "error", 60: "fatal" },
  },
};

vi.mock("../src/lib/logger.js", () => ({
  default: mockLoggerInstance,
  requestContext: { getStore: vi.fn() },
}));

vi.mock("../src/lib/stellar.js", () => ({
  checkRpcHealth: vi.fn().mockResolvedValue({
    status: "healthy",
    rpc: { reachable: true },
    contract: { reachable: true },
    timestamp: new Date().toISOString(),
  }),
}));

vi.mock("../src/lib/contract.js", () => ({
  getSubmitQueueDepth: vi.fn().mockReturnValue(0),
  drainSubmitQueue: vi.fn().mockResolvedValue(undefined),
  getPendingTransactionCount: vi.fn().mockReturnValue(0),
  getPendingTransactions: vi.fn().mockReturnValue([]),
  dumpPendingTransactions: vi.fn(),
  resumePendingTransactions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/config.js", () => ({
  default: {
    nodeEnv: "test",
    port: 3001,
    logLevel: "info",
    stellar: { network: "testnet", rpcUrl: "https://soroban-testnet.stellar.org" },
    contract: { id: "mock" },
    server: { secret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAO7Q" },
    corsOrigin: "*",
    jsonBodyLimit: "100kb",
    trustProxy: false,
    shutdownTimeoutMs: 35000,
    rateLimit: {
      windowMs: 60000,
      max: 20,
      payment: { windowMs: 60000, max: 10 },
    },
    demoRun: { pollMaxWaitMs: 8000, pollInitialDelayMs: 250, pollMaxDelayMs: 2000 },
    x402: { facilitatorUrl: "http://localhost", searchPrice: "0.001", weatherPrice: "0.001", payTo: "GAAA" },
  },
  validateConfig: vi.fn(),
}));

describe("Security Headers (Helmet Middleware)", () => {
  let app;

  beforeEach(async () => {
    vi.clearAllMocks();
    const indexModule = await import("../src/index.js");
    app = indexModule.default || indexModule.app;
  });

  it("omits the X-Powered-By header", async () => {
    const response = await request(app).get("/healthz");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("includes X-Content-Type-Options: nosniff", async () => {
    const response = await request(app).get("/healthz");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("includes X-Frame-Options header", async () => {
    const response = await request(app).get("/healthz");
    expect(response.headers["x-frame-options"]).toBeDefined();
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("includes Strict-Transport-Security header", async () => {
    const response = await request(app).get("/healthz");
    expect(response.headers["strict-transport-security"]).toBeDefined();
  });

  it("includes Content-Security-Policy header", async () => {
    const response = await request(app).get("/healthz");
    expect(response.headers["content-security-policy"]).toBeDefined();
  });
});
