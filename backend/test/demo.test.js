import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import demoRouter from "../src/routes/demo.js";
import * as contract from "../src/lib/contract.js";

vi.mock("../src/lib/contract.js", () => ({
  getService: vi.fn(),
}));

vi.mock("../src/routes/demoValidate.js", () => ({
  validateDemoEndpoint: vi.fn().mockReturnValue("http://localhost:9999/demo"),
}));

vi.mock("@x402/core/client", () => {
  return {
    x402Client: vi.fn().mockImplementation(() => ({
      register: vi.fn().mockReturnThis(),
    })),
    x402HTTPClient: vi.fn().mockImplementation(() => ({
      fetchWithTx: vi.fn(),
    })),
  };
});

vi.mock("@x402/stellar", () => ({
  createEd25519Signer: vi.fn(),
}));

vi.mock("@x402/stellar/exact/client", () => ({
  ExactStellarScheme: vi.fn(),
}));

const app = express();
app.use(express.json());
app.use("/api", demoRouter);

describe("POST /api/demo-run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 if serviceId or category is missing", async () => {
    const res = await request(app).post("/api/demo-run").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("serviceId and category are required");
  });

  it("handles AbortError appropriately", async () => {
    contract.getService.mockResolvedValue({ name: "Test Service", endpoint: "test", price_usdc: "1" });

    // buildHttpClient() replaces fetchWithTx with a custom implementation that
    // calls global fetch internally.  Mocking the x402HTTPClient constructor
    // has no effect — we need to stub global.fetch so that the real
    // fetchWithTx (called by the route) receives an AbortError, which the
    // route translates into a 499 CANCELLED response.
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );

    try {
      const res = await request(app).post("/api/demo-run").send({ serviceId: 1, category: "weather" });
      expect(res.status).toBe(499);
      expect(res.body.code).toBe("CANCELLED");
    } finally {
      global.fetch = originalFetch;
    }
  });
  });
});
