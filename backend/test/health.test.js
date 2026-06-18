import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the modules first
vi.mock("../src/config.js", () => ({
  default: {
    stellar: {
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
    },
    contract: {
      id: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    },
    server: {
      secret: "SBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHF2Q",
    },
  },
}));

vi.mock("../src/lib/logger.js", () => ({
  default: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

let mockServer;
let getStellarServerMock;

describe("checkRpcHealth", () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    mockServer = {
      getNetwork: vi.fn(),
      getAccount: vi.fn(),
    };

    // Dynamically import and mock getStellarServer
    const stellar = await import("../src/lib/stellar.js");
    getStellarServerMock = vi.spyOn(stellar, "getStellarServer");
    getStellarServerMock.mockReturnValue(mockServer);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns healthy status when RPC and contract are reachable", async () => {
    const { checkRpcHealth } = await import("../src/lib/stellar.js");

    mockServer.getNetwork.mockResolvedValue({});
    mockServer.getAccount.mockResolvedValue({ id: "account123" });

    const health = await checkRpcHealth();

    expect(health.status).toBe("healthy");
    expect(health.rpc.reachable).toBe(true);
    expect(health.contract.reachable).toBe(true);
    expect(health.error).toBeNull();
  });

  it("returns unhealthy status when RPC is unreachable", async () => {
    const { checkRpcHealth } = await import("../src/lib/stellar.js");

    mockServer.getNetwork.mockRejectedValue(new Error("Connection refused"));

    const health = await checkRpcHealth();

    expect(health.status).toBe("unhealthy");
    expect(health.rpc.reachable).toBe(false);
    expect(health.error).toBe("Connection refused");
  });

  it("returns degraded status when contract is unreachable but RPC is up", async () => {
    const { checkRpcHealth } = await import("../src/lib/stellar.js");

    mockServer.getNetwork.mockResolvedValue({});
    mockServer.getAccount.mockRejectedValue(new Error("Account not found"));

    const health = await checkRpcHealth();

    expect(health.status).toBe("degraded");
    expect(health.rpc.reachable).toBe(true);
    expect(health.contract.reachable).toBe(false);
    expect(health.contract.error).toBe("Account not found");
  });

  it("measures RPC latency", async () => {
    const { checkRpcHealth } = await import("../src/lib/stellar.js");

    mockServer.getNetwork.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({}), 50);
        }),
    );
    mockServer.getAccount.mockResolvedValue({ id: "account123" });

    const health = await checkRpcHealth();

    expect(health.rpc.latency).toBeGreaterThanOrEqual(50);
    expect(health.rpc.latency).toBeLessThan(200);
  });

  it("returns degraded status when server keypair is not available", async () => {
    const { checkRpcHealth } = await import("../src/lib/stellar.js");

    mockServer.getNetwork.mockResolvedValue({});

    const health = await checkRpcHealth();

    expect(health.status).toBe("degraded");
    expect(health.rpc.reachable).toBe(true);
    expect(health.contract.reachable).toBeNull();
    expect(health.contract.message).toContain("skipped");
  });

  it("includes timestamp in ISO format", async () => {
    const { checkRpcHealth } = await import("../src/lib/stellar.js");

    mockServer.getNetwork.mockResolvedValue({});
    mockServer.getAccount.mockResolvedValue({ id: "account123" });

    const health = await checkRpcHealth();

    expect(health.timestamp).toBeDefined();
    expect(() => new Date(health.timestamp)).not.toThrow();
  });
});
