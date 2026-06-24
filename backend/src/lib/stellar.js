import pkg from "@stellar/stellar-sdk";
const { rpc, Networks, Keypair } = pkg;
import config from "../config.js";
import logger from "./logger.js";

let _server = null;

export function getStellarServer() {
  if (!_server) {
    _server = new rpc.Server(config.stellar.rpcUrl, {
      allowHttp: config.stellar.rpcUrl.startsWith("http://"),
    });
  }
  return _server;
}

export async function getCurrentLedgerSequence() {
  const ledger = await getStellarServer().getLatestLedger();
  return ledger.sequence;
}

export function getNetworkPassphrase() {
  if (config.stellar.network === "mainnet") {
    return Networks.PUBLIC;
  }
  return Networks.TESTNET;
}

export function getUSDCContractId() {
  return config.stellar.usdcContractId;
}

/**
 * Check RPC server connectivity and contract reachability.
 * Returns a health status object with connection and contract status.
 */
export async function checkRpcHealth() {
  const result = {
    rpc: { reachable: false, latency: 0 },
    contract: { reachable: false },
    status: "unhealthy",
    error: null,
    timestamp: new Date().toISOString(),
  };

  try {
    const server = getStellarServer();
    const startTime = Date.now();

    // Test basic RPC connectivity by fetching network details
    await server.getNetwork();
    result.rpc.latency = Date.now() - startTime;
    result.rpc.reachable = true;
    logger.debug(
      { latency: result.rpc.latency },
      "RPC server health check passed",
    );
  } catch (err) {
    result.error = err.message;
    logger.warn({ error: result.error }, "RPC server health check failed");
    return result;
  }

  try {
    // Test contract reachability by attempting to fetch server account
    const server = getStellarServer();
    const startTime = Date.now();

    // Use the server keypair from config if available
    if (!config.server?.secret) {
      result.contract.reachable = null;
      result.contract.message =
        "Contract check skipped (no server key available)";
      result.status = "degraded";
      logger.debug("Contract health check skipped");
      return result;
    }

    const keypair = Keypair.fromSecret(config.server.secret);
    const account = await server.getAccount(keypair.publicKey());
    result.contract.latency = Date.now() - startTime;
    result.contract.reachable = true;
    result.status = "healthy";
    logger.debug(
      { latency: result.contract.latency },
      "Contract health check passed",
    );
  } catch (err) {
    result.contract.error = err.message;
    result.status = "degraded";
    logger.warn(
      { error: result.contract.error },
      "Contract health check failed",
    );
  }

  return result;
}
