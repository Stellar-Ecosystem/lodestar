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
    updatePolicyOnChain: vi.fn(),
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

describe("PUT /api/agents/:address/policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const agentAddress = "GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ";

  it("updates policy successfully with valid parameters", async () => {
    contract.updatePolicyOnChain.mockResolvedValue(true);

    const policyUpdate = {
      maxPerTxStroops: "10000000",
      maxPerDayStroops: "50000000",
      allowedCategories: ["weather", "news"],
      minScoreToEarn: 500,
    };

    const response = await request(app)
      .put(`/api/agents/${agentAddress}/policy`)
      .send(policyUpdate);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(contract.updatePolicyOnChain).toHaveBeenCalledWith(
      agentAddress,
      policyUpdate.maxPerTxStroops,
      policyUpdate.maxPerDayStroops,
      policyUpdate.allowedCategories,
      policyUpdate.minScoreToEarn,
      "GBOWOWNER"
    );
  });

  it("returns 400 for invalid policy parameters", async () => {
    const invalidPolicy = {
      maxPerTxStroops: "10000000",
      // missing maxPerDayStroops
      allowedCategories: "not-an-array",
      minScoreToEarn: "not-a-number",
    };

    const response = await request(app)
      .put(`/api/agents/${agentAddress}/policy`)
      .send(invalidPolicy);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_BODY");
    expect(contract.updatePolicyOnChain).not.toHaveBeenCalled();
  });

  it("returns 400 when allowedCategories is not an array", async () => {
    const response = await request(app)
      .put(`/api/agents/${agentAddress}/policy`)
      .send({
        maxPerTxStroops: "10000000",
        maxPerDayStroops: "50000000",
        allowedCategories: "weather",
        minScoreToEarn: 0,
      });

    expect(response.status).toBe(400);
    expect(contract.updatePolicyOnChain).not.toHaveBeenCalled();
  });
});

describe("POST /api/agents/:address/build-tx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const agentAddress = "GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ";

  it("builds update_policy tx with valid parameters", async () => {
    contract.buildUnsignedAgentTx.mockResolvedValue("mock-xdr-base64");
    const policyParams = {
      action: 'update_policy',
      maxPerTxStroops: "10000000",
      maxPerDayStroops: "50000000",
      allowedCategories: ["weather"],
      minScoreToEarn: 100,
    };

    const response = await request(app)
      .post(`/api/agents/${agentAddress}/build-tx`)
      .send(policyParams);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("xdr");
  });

  it("returns 400 for invalid action in build-tx", async () => {
    const response = await request(app)
      .post(`/api/agents/${agentAddress}/build-tx`)
      .send({ action: "invalid-action" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_BODY");
  });

  it("returns 400 for invalid update_policy params in build-tx", async () => {
    const response = await request(app)
      .post(`/api/agents/${agentAddress}/build-tx`)
      .send({
        action: "update_policy",
        maxPerTxStroops: "10000000",
        // missing maxPerDayStroops
        allowedCategories: [],
        minScoreToEarn: 0
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_BODY");
  });
});
