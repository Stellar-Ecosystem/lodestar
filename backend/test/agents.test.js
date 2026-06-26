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
    flagAgentOnChain: vi.fn(),
    adminDeactivateAgentOnChain: vi.fn(),
    getAgent: vi.fn(),
    getAgentPolicy: vi.fn(),
    recordPaymentOnChain: vi.fn(),
  };
});

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

describe("POST /api/admin/agents/:address/flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock the secret used in adminAuth
    vi.stubEnv("SERVER_STELLAR_SECRET", "SDY6B5V7K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5");
  });

  it("requires a valid admin key (HMAC)", async () => {
    const address = "GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ";
    const body = { reason: "Suspicious activity" };

    const res = await request(app)
      .post(`/api/admin/agents/${address}/flag`)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("ADMIN_KEY_MISSING");
  });

  it("flags an agent successfully with valid admin key", async () => {
    const address = "GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ";
    const body = { reason: "Suspicious activity" };
    const secret = "SDY6B5V7K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5";

    const crypto = await import("crypto");
    const expected = crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify(body))
      .digest("hex");

    contract.flagAgentOnChain.mockResolvedValue(true);

    const res = await request(app)
      .post(`/api/admin/agents/${address}/flag`)
      .set("x-admin-key", expected)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(contract.flagAgentOnChain).toHaveBeenCalledWith(address, "Suspicious activity");
  });
});

describe("POST /api/admin/agents/:address/deactivate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SERVER_STELLAR_SECRET", "SDY6B5V7K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5");
  });

  it("admin deactivates an agent successfully", async () => {
    const address = "GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ";
    const body = {};
    const secret = "SDY6B5V7K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5";

    const crypto = await import("crypto");
    const expected = crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify(body))
      .digest("hex");

    contract.adminDeactivateAgentOnChain.mockResolvedValue(true);

    const res = await request(app)
      .post(`/api/admin/agents/${address}/deactivate`)
      .set("x-admin-key", expected)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(contract.adminDeactivateAgentOnChain).toHaveBeenCalledWith(address);
  });
});

describe("GET /api/agents/:address", () => {
  it("returns 404 if agent not found", async () => {
    contract.getAgent.mockResolvedValue(null);
    const res = await request(app).get("/api/agents/GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ");
    expect(res.status).toBe(404);
  });

  it("returns agent and policy if found", async () => {
    const mockAgent = { address: "GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ", score: 100 };
    const mockPolicy = { max_per_tx_stroops: "1000" };
    contract.getAgent.mockResolvedValue(mockAgent);
    contract.getAgentPolicy.mockResolvedValue(mockPolicy);

    const res = await request(app).get(`/api/agents/${mockAgent.address}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agent: mockAgent, policy: mockPolicy });
  });
});

describe("POST /api/agents/:address/payment", () => {
  const secret = "SDY6B5V7K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5K5L5";
  const address = "GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ";

  beforeEach(() => {
    vi.stubEnv("SERVER_STELLAR_SECRET", secret);
  });

  it("requires HMAC auth", async () => {
    const res = await request(app).post(`/api/agents/${address}/payment`).send({});
    expect(res.status).toBe(401);
  });

  it("records payment successfully", async () => {
    const body = { amountUsdc: 0.01, success: true, serviceId: 1 };
    const crypto = await import("crypto");
    const hmac = crypto.createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex");

    contract.getAgent.mockResolvedValue({ score: 110 });
    contract.recordPaymentOnChain.mockResolvedValue(true);

    const res = await request(app)
      .post(`/api/agents/${address}/payment`)
      .set("x-lodestar-signature", hmac)
      .set("x-idempotency-key", "unique-key-1")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.newScore).toBe(110);
  });
});
