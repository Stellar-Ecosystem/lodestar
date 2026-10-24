import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

/**
 * Integration coverage for the demo service routes:
 *
 * - GET /demo/weather — the request is validated against a schema before the
 *   route reaches the upstream provider or the contract layer (#675).
 * - GET /demo/search — the route is exercised through the real application
 *   (#677).
 *
 * The application is mounted exactly as in `src/index.js`; only the contract
 * layer and the x402 payment middleware are replaced.
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
// The weather ceiling is asserted in services.rateLimit.test.js — here it is
// raised so the validation tests are not throttled.
process.env.WEATHER_RATE_LIMIT_MAX = "1000";

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

// The x402 payment middleware is stubbed: no facilitator call is attempted and
// the route is reached without a payment header.
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

const WEATHER_RESPONSE = {
  ok: true,
  json: async () => ({
    current: {
      temperature_2m: 21,
      wind_speed_10m: 7,
      weather_code: 2,
      time: "2026-01-01T00:00",
    },
  }),
};

const SEARCH_RESPONSE = {
  ok: true,
  json: async () => ({
    organic: [
      { title: "Lodestar", link: "https://lodestar.example", snippet: "Discovery" },
      { title: "x402", link: "https://x402.example", snippet: "Payments" },
    ],
  }),
};

beforeAll(async () => {
  ({ app } = await import("../src/index.js"));
  contract = await import("../src/lib/contract.js");
});

beforeEach(() => {
  vi.clearAllMocks();
  contract.getAgent.mockResolvedValue(null);
  global.fetch = vi.fn().mockResolvedValue(WEATHER_RESPONSE);
});

describe("GET /demo/weather — request validation (#675)", () => {
  it("serves the default location when no coordinates are supplied", async () => {
    const res = await request(app).get("/demo/weather");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.latitude).toBe(40.7128);
    expect(res.body.longitude).toBe(-74.006);
  });

  it("serves the requested coordinates", async () => {
    const res = await request(app).get("/demo/weather?lat=10.5&lon=-20.25");

    expect(res.status).toBe(200);
    expect(res.body.latitude).toBe(10.5);
    expect(res.body.longitude).toBe(-20.25);
  });

  it.each([
    ["a missing value", "lat=&lon=0"],
    ["a wrong type", "lat=abc&lon=0"],
    ["a trailing-garbage value", "lat=12abc&lon=0"],
    ["an out-of-range latitude", "lat=91&lon=0"],
    ["an out-of-range longitude", "lat=0&lon=181"],
  ])("rejects %s with 400 INVALID_COORDINATES", async (_case, query) => {
    const res = await request(app).get(`/demo/weather?${query}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_COORDINATES");
  });

  it("rejects a repeated query parameter instead of picking one", async () => {
    const res = await request(app).get("/demo/weather?lat=1&lat=2");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_COORDINATES");
  });

  it("rejects an over-long demoRunId with 400 INVALID_QUERY", async () => {
    const res = await request(app).get(
      `/demo/weather?demoRunId=${"a".repeat(65)}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_QUERY");
  });

  it("rejects a body the route does not accept with 400 INVALID_BODY", async () => {
    const res = await request(app)
      .get("/demo/weather")
      .set("Content-Type", "application/json")
      .send({ unexpected: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_BODY");
  });

  it("never reaches the upstream provider or the contract layer for invalid input", async () => {
    const res = await request(app).get("/demo/weather?lat=abc");

    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(contract.getAgent).not.toHaveBeenCalled();
    expect(contract.recordPaymentOnChain).not.toHaveBeenCalled();
  });

  it("runs behind the mounted middleware: the request id is on the response and on the error body", async () => {
    const res = await request(app)
      .get("/demo/weather?lat=999")
      .set("X-Request-Id", "integration-weather-1");

    expect(res.status).toBe(400);
    expect(res.headers["x-request-id"]).toBe("integration-weather-1");
    expect(res.body.requestId).toBe("integration-weather-1");
  });
});

describe("GET /demo/search (integration)", () => {
  it("serves the search results for a valid query", async () => {
    global.fetch = vi.fn().mockResolvedValue(SEARCH_RESPONSE);

    const res = await request(app).get("/demo/search?q=stellar+payments");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.query).toBe("stellar payments");
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0]).toEqual({
      title: "Lodestar",
      url: "https://lodestar.example",
      description: "Discovery",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://google.serper.dev/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ q: "stellar payments", num: 5 }),
      }),
    );
  });

  it("echoes the payment transaction header of a paid request", async () => {
    global.fetch = vi.fn().mockResolvedValue(SEARCH_RESPONSE);

    const res = await request(app)
      .get("/demo/search?q=stellar")
      .set("x-payment-transaction", "tx-integration-1");

    expect(res.status).toBe(200);
    expect(res.headers["x-payment-transaction"]).toBe("tx-integration-1");
  });

  it("rejects a missing query with 400 MISSING_QUERY", async () => {
    const res = await request(app).get("/demo/search");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("MISSING_QUERY");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects an over-long query with 400 INVALID_QUERY", async () => {
    const res = await request(app).get(`/demo/search?q=${"a".repeat(257)}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_QUERY");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a query that is only whitespace with 400 INVALID_QUERY", async () => {
    const res = await request(app).get("/demo/search?q=%20%20%20");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_QUERY");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("answers 500 SEARCH_ERROR when the search provider fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const res = await request(app).get("/demo/search?q=stellar");

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("SEARCH_ERROR");
  });

  it("runs behind the mounted middleware: the request id is on the response and on the error body", async () => {
    const res = await request(app)
      .get("/demo/search")
      .set("X-Request-Id", "integration-search-1");

    expect(res.status).toBe(400);
    expect(res.headers["x-request-id"]).toBe("integration-search-1");
    expect(res.body.requestId).toBe("integration-search-1");
  });
});
