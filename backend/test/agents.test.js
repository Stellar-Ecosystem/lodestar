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
    getAgentPolicy: vi.fn(),

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
describe("GET /api/agents/:address/policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 and policy data for valid agent address", async () => {
    const mockPolicy = {
      max_per_tx_stroops: "10000000",
      max_per_day_stroops: "50000000",
      daily_spent_stroops: "0",
      allowed_categories: ["weather", "search"],
    };
    contract.getAgentPolicy.mockResolvedValueOnce(mockPolicy);

    const res = await request(app).get(`/api/agents/${VALID_ADDR}/policy`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockPolicy);
    expect(contract.getAgentPolicy).toHaveBeenCalledWith(VALID_ADDR);
  });

  it("returns 404 NOT_FOUND when policy does not exist", async () => {
    contract.getAgentPolicy.mockResolvedValueOnce(null);

    const res = await request(app).get(`/api/agents/${VALID_ADDR}/policy`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Policy not found", code: "NOT_FOUND" });
    expect(contract.getAgentPolicy).toHaveBeenCalledWith(VALID_ADDR);
  });

  it("returns 400 with specific code when address param is missing or empty", async () => {
    const res = await request(app).get("/api/agents/%20/policy");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PARAMS");
    expect(contract.getAgentPolicy).not.toHaveBeenCalled();
  });

  it("rejects wrong-type address (e.g. non-string) with 400 and INVALID_PARAMS", async () => {
    const req = { params: { address: 12345 }, query: {}, body: undefined };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();

    const { validateGetAgentPolicy } = await import("../src/routes/agents.js");
    validateGetAgentPolicy(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INVALID_PARAMS" })
    );
    expect(next).not.toHaveBeenCalled();
    expect(contract.getAgentPolicy).not.toHaveBeenCalled();
  });

  it("returns 400 with specific code when address is out-of-range (too short)", async () => {
    const tooShort = "GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH"; // 55 chars
    const res = await request(app).get(`/api/agents/${tooShort}/policy`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_ADDRESS");
    expect(contract.getAgentPolicy).not.toHaveBeenCalled();
  });

  it("returns 400 with specific code when address is out-of-range (too long)", async () => {
    const tooLong = "GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3A"; // 57 chars
    const res = await request(app).get(`/api/agents/${tooLong}/policy`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_ADDRESS");
    expect(contract.getAgentPolicy).not.toHaveBeenCalled();
  });

  it("returns 400 with specific code when address contains invalid characters", async () => {
    const invalidChars = "G0189X3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3";
    const res = await request(app).get(`/api/agents/${invalidChars}/policy`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_ADDRESS");
    expect(contract.getAgentPolicy).not.toHaveBeenCalled();
  });

  it("returns 400 with specific code when address has wrong prefix", async () => {
    const wrongPrefix = "CAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3";
    const res = await request(app).get(`/api/agents/${wrongPrefix}/policy`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_ADDRESS");
    expect(contract.getAgentPolicy).not.toHaveBeenCalled();
  });

  it("returns 400 with specific code when query parameters are supplied", async () => {
    const res = await request(app).get(`/api/agents/${VALID_ADDR}/policy?unexpected=value`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_QUERY");
    expect(contract.getAgentPolicy).not.toHaveBeenCalled();
  });

  it("returns 400 with specific code when body is supplied", async () => {
    const res = await request(app)
      .get(`/api/agents/${VALID_ADDR}/policy`)
      .send({ unexpected: "body" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_BODY");
    expect(contract.getAgentPolicy).not.toHaveBeenCalled();
  });

  it("never returns a 500 when input is invalid", async () => {
    const invalidInputs = [
      `/api/agents/short/policy`,
      `/api/agents/123/policy`,
      `/api/agents/${VALID_ADDR}/policy?foo=bar`,
    ];

    for (const path of invalidInputs) {
      const res = await request(app).get(path);
      expect(res.status).toBe(400);
      expect(res.status).not.toBe(500);
    }
    expect(contract.getAgentPolicy).not.toHaveBeenCalled();
  });
});
