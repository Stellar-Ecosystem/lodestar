import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

/**
 * Integration coverage for GET /api/services/:id/history (#659).
 *
 * The route is exercised through the real application — the router as it is
 * mounted in `src/index.js`, with the request logger, the request context and
 * the error handler in front of it — so a regression in the middleware order
 * or in the mounted path fails here instead of shipping.
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

const mockGetReputationHistory = vi.fn();
vi.mock("../src/lib/reputationHistory.js", async () => {
  const actual = await vi.importActual("../src/lib/reputationHistory.js");
  return {
    ...actual,
    getReputationHistory: (...args) => mockGetReputationHistory(...args),
  };
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
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetReputationHistory.mockReturnValue([]);
});

function makeService(overrides = {}) {
  return {
    id: 1,
    name: "Test Service",
    description: "A test service description",
    endpoint: "https://test.example.com",
    price_usdc: "1.00",
    category: "weather",
    provider: "GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3",
    reputation: 100,
    active: true,
    registered_at: 1000,
    ...overrides,
  };
}

describe("GET /api/services/:id/history (integration)", () => {
  it("serves the history of an existing service", async () => {
    const history = [
      { timestamp: 1718170000000, delta: 1, newValue: 1 },
      { timestamp: 1718170100000, delta: 1, newValue: 2 },
    ];
    contract.getService.mockResolvedValue(makeService({ id: 7 }));
    mockGetReputationHistory.mockReturnValue(history);

    const res = await request(app).get("/api/services/7/history");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ history });
    expect(contract.getService).toHaveBeenCalledWith(7);
    expect(mockGetReputationHistory).toHaveBeenCalledWith(7);
  });

  it("serves an empty history for a service without reputation changes", async () => {
    contract.getService.mockResolvedValue(makeService({ id: 3 }));
    mockGetReputationHistory.mockReturnValue([]);

    const res = await request(app).get("/api/services/3/history");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ history: [] });
  });

  it("rejects a non-numeric service id with 400 INVALID_ID", async () => {
    const res = await request(app).get("/api/services/not-a-number/history");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_ID");
    expect(contract.getService).not.toHaveBeenCalled();
  });

  it("answers 404 NOT_FOUND for an unknown service", async () => {
    contract.getService.mockResolvedValue(null);

    const res = await request(app).get("/api/services/999/history");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(mockGetReputationHistory).not.toHaveBeenCalled();
  });

  it("answers 500 FETCH_ERROR when the contract read fails", async () => {
    contract.getService.mockRejectedValue(new Error("RPC unreachable"));

    const res = await request(app).get("/api/services/1/history");

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("FETCH_ERROR");
  });

  it("runs behind the mounted middleware: the request id is on the response and on the error body", async () => {
    contract.getService.mockRejectedValue(new Error("RPC unreachable"));

    const res = await request(app)
      .get("/api/services/1/history")
      .set("X-Request-Id", "integration-history-1");

    expect(res.status).toBe(500);
    // `requestContextMiddleware` runs before the router and stamps the
    // request id on every error response, and on the response header.
    expect(res.headers["x-request-id"]).toBe("integration-history-1");
    expect(res.body.requestId).toBe("integration-history-1");
  });

  it("keeps the request id of an inbound request across the whole chain", async () => {
    contract.getService.mockResolvedValue(makeService({ id: 1 }));

    const res = await request(app)
      .get("/api/services/1/history")
      .set("X-Request-Id", "integration-history-2");

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBe("integration-history-2");
  });
});
