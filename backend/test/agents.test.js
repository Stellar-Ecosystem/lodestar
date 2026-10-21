import { _reset as resetIdempotencyStore } from '../src/lib/idempotency.js';
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import agentsRouter from "../src/routes/agents.js";
import * as contract from "../src/lib/contract.js";

// Mock the dependencies
vi.mock("../src/lib/contract.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    registerAgentOnChain: vi.fn(),
    isAgentRegistered: vi.fn(),
    buildUnsignedAgentTx: vi.fn(),

  };
});

vi.mock("../src/middleware/ownerAuth.js", () => ({
  ownerAuth: (req, res, next) => {
    req.callerAddress = "GBOWOWNER";
    next();
  },
}));

vi.mock("../src/config.js", () => ({
  default: {
    contract: { agentsId: "mock-agents-contract-id" },
    rateLimit: { payment: { max: 10, windowMs: 60000 }, write: { max: 10, windowMs: 60000 } },
    server: {
      secret: "SDY6B5V7K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5"
    }
  },
}));

vi.mock("../src/lib/logger.js", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// We can bypass rate limiters and auth for the purpose of testing the route logic
vi.mock("../src/middleware/rateLimiter.js", () => ({
  writeRateLimiter: () => (req, res, next) => next(),
  paymentRateLimiter: () => (req, res, next) => next(),
}));

vi.mock("../src/middleware/addressValidator.js", () => ({
  validateAgentAddressParam: (req, res, next) => next(),
  isValidStellarAddress: vi.fn(() => true), // Mock all addresses as valid for simplicity
}));

const app = express();
app.use(express.json());
app.use("/api", agentsRouter);

describe("POST /api/agents/register", () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.clearAllMocks();
  });

  it("returns 409 early if agent is already registered", async () => {
    contract.isAgentRegistered.mockResolvedValue(true);

    const response = await request(app).post("/api/agents/register").send({
      agentAddress: "GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ",
      name: "Test Agent",
      description: "A valid test agent description",
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "Agent already registered",
      code: "ALREADY_EXISTS",
      agentAddress: "GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ",
    });

    // Ensure registerAgentOnChain is never called
    expect(contract.registerAgentOnChain).not.toHaveBeenCalled();
  });

  it("registers successfully if agent is not registered", async () => {
    contract.isAgentRegistered.mockResolvedValue(false);
    contract.registerAgentOnChain.mockResolvedValue(1);

    const response = await request(app).post("/api/agents/register").send({
      agentAddress: "GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ",
      name: "Test Agent",
      description: "A valid test agent description",
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      success: true,
      agentCount: 1,
      agentAddress: "GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ",
    });
    expect(contract.registerAgentOnChain).toHaveBeenCalledWith(
      "GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ",
      "Test Agent",
      "A valid test agent description"
    );
  });
});

const { mockGetActivityFeed, mockParseActivityPagination } = vi.hoisted(() => ({
  mockGetActivityFeed: vi.fn(() => []),
  mockParseActivityPagination: vi.fn(() => ({ limit: 20, offset: 0, errors: [] })),
}));

vi.mock('../src/lib/activityFeed.js', async () => {
  const actual = await vi.importActual('../src/lib/activityFeed.js');
  return {
    ...actual,
    getActivityFeed: (...args) => mockGetActivityFeed(...args),
    parseActivityPagination: (...args) => mockParseActivityPagination(...args),
  };
});

const VALID_ADDR = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';

describe('GET /api/agents/:address/payment-history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns paginated payment history for a given agent', async () => {
    mockGetActivityFeed.mockReturnValue([
      { agent: VALID_ADDR, txHash: 'abc123', service: 'Weather', amount: '0.001', timestamp: '2026-01-01T00:00:00Z' },
      { agent: VALID_ADDR, txHash: 'def456', service: 'Search', amount: '0.002', timestamp: '2026-01-01T01:00:00Z' },
      { agent: 'GOTHER', txHash: 'other1', service: 'Weather', amount: '0.001', timestamp: '2026-01-01T02:00:00Z' },
    ]);

    const res = await request(app).get(`/api/agents/${VALID_ADDR}/payment-history`);
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(2);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.pagination.hasMore).toBe(false);
  });

  it('returns empty payments when no activity matches the agent', async () => {
    mockGetActivityFeed.mockReturnValue([]);

    const res = await request(app).get(`/api/agents/${VALID_ADDR}/payment-history`);
    expect(res.status).toBe(200);
    expect(res.body.payments).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it('excludes entries without txHash', async () => {
    mockGetActivityFeed.mockReturnValue([
      { agent: VALID_ADDR, txHash: '', service: 'Weather', amount: '0.001' },
      { agent: VALID_ADDR, txHash: 'real123', service: 'Weather', amount: '0.001' },
      { agent: VALID_ADDR, service: 'NoHash', amount: '0.001' },
    ]);

    const res = await request(app).get(`/api/agents/${VALID_ADDR}/payment-history`);
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(1);
  });

  it('respects pagination params', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      agent: VALID_ADDR,
      txHash: `tx-${i}`,
      service: 'Weather',
      amount: '0.001',
    }));
    mockGetActivityFeed.mockReturnValue(entries);
    mockParseActivityPagination.mockReturnValueOnce({ limit: 10, offset: 5, errors: [] });

    const res = await request(app).get(`/api/agents/${VALID_ADDR}/payment-history?limit=10&offset=5`);
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(10);
    expect(res.body.pagination.total).toBe(25);
    expect(res.body.pagination.hasMore).toBe(true);
  });

  it('returns 400 when pagination params are invalid', async () => {
    mockParseActivityPagination.mockReturnValueOnce({ limit: 0, offset: 0, errors: ['`limit` must be a positive integer'] });
    mockGetActivityFeed.mockReturnValueOnce([]);

    const res = await request(app).get(`/api/agents/${VALID_ADDR}/payment-history?limit=-1`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAGINATION');
  });
});

describe("POST /api/agents/:address/build-tx", () => {
  const agentAddress = "GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3";
  const validBody = { action: "deactivate" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires Idempotency-Key header", async () => {
    const res = await request(app)
      .post(`/api/agents/${agentAddress}/build-tx`)
      .send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_MISSING");
  });

  it("rejects invalid Idempotency-Key header (empty or invalid characters)", async () => {
    const res = await request(app)
      .post(`/api/agents/${agentAddress}/build-tx`)
      .set("Idempotency-Key", "invalid key with spaces")
      .send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_INVALID");
  });

  it("builds transaction successfully with Idempotency-Key", async () => {
    contract.buildUnsignedAgentTx.mockResolvedValueOnce("AAAA_MOCK_XDR_DEACTIVATE");

    const res = await request(app)
      .post(`/api/agents/${agentAddress}/build-tx`)
      .set("Idempotency-Key", "idem-build-1")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ xdr: "AAAA_MOCK_XDR_DEACTIVATE" });
    expect(contract.buildUnsignedAgentTx).toHaveBeenCalledTimes(1);
    expect(contract.buildUnsignedAgentTx).toHaveBeenCalledWith("deactivate", agentAddress, {});
  });

  it("replays cached response on duplicate request with same key and produces exactly one effect", async () => {
    contract.buildUnsignedAgentTx.mockResolvedValueOnce("AAAA_MOCK_XDR_DEACTIVATE");

    // First request
    const firstRes = await request(app)
      .post(`/api/agents/${agentAddress}/build-tx`)
      .set("Idempotency-Key", "idem-build-replay-test")
      .send(validBody);

    expect(firstRes.status).toBe(200);
    expect(firstRes.body).toEqual({ xdr: "AAAA_MOCK_XDR_DEACTIVATE" });
    expect(contract.buildUnsignedAgentTx).toHaveBeenCalledTimes(1);

    // Duplicate request with the exact same key
    const replayRes = await request(app)
      .post(`/api/agents/${agentAddress}/build-tx`)
      .set("Idempotency-Key", "idem-build-replay-test")
      .send(validBody);

    expect(replayRes.status).toBe(200);
    expect(replayRes.body).toEqual({ xdr: "AAAA_MOCK_XDR_DEACTIVATE", idempotent: true });
    // Exactly one underlying execution
    expect(contract.buildUnsignedAgentTx).toHaveBeenCalledTimes(1);
  });

  it("accepts X-Idempotency-Key header as an alias", async () => {
    contract.buildUnsignedAgentTx.mockResolvedValueOnce("AAAA_MOCK_XDR_ALIAS");

    const res = await request(app)
      .post(`/api/agents/${agentAddress}/build-tx`)
      .set("X-Idempotency-Key", "idem-alias-key")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ xdr: "AAAA_MOCK_XDR_ALIAS" });
    expect(contract.buildUnsignedAgentTx).toHaveBeenCalledTimes(1);
  });

  it("replays failed response without re-executing buildUnsignedAgentTx", async () => {
    contract.buildUnsignedAgentTx.mockRejectedValueOnce(new Error("Soroban simulation failed"));

    const firstRes = await request(app)
      .post(`/api/agents/${agentAddress}/build-tx`)
      .set("Idempotency-Key", "idem-fail-test")
      .send(validBody);

    expect(firstRes.status).toBe(500);
    expect(firstRes.body.code).toBe("BUILD_TX_ERROR");
    expect(contract.buildUnsignedAgentTx).toHaveBeenCalledTimes(1);

    const retryRes = await request(app)
      .post(`/api/agents/${agentAddress}/build-tx`)
      .set("Idempotency-Key", "idem-fail-test")
      .send(validBody);

    expect(retryRes.status).toBe(500);
    expect(retryRes.body).toEqual({
      error: "Failed to build transaction",
      code: "BUILD_TX_ERROR",
      idempotent: true,
    });
    expect(contract.buildUnsignedAgentTx).toHaveBeenCalledTimes(1);
  });
});
