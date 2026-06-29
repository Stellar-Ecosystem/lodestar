import express from "express";
import cors from "cors";
import config from "./config.js";
import logger from "./lib/logger.js";
import { checkRpcHealth } from "./lib/stellar.js";
import {
  getSubmitQueueDepth,
  drainSubmitQueue,
  getPendingTransactionCount,
  getPendingTransactions,
  dumpPendingTransactions,
  resumePendingTransactions,
} from "./lib/contract.js";
import registryRouter from "./routes/registry.js";
import servicesRouter from "./routes/services.js";
import demoRouter from "./routes/demo.js";
import agentsRouter from "./routes/agents.js";

const app = express();

// Trust the configured number of proxy hops so req.ip reflects the real client
// (via X-Forwarded-For) behind a reverse proxy — required for correct IP-based
// rate limiting. Defaults to false (no proxy) to avoid X-Forwarded-For spoofing.
app.set("trust proxy", config.trustProxy);

app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: config.jsonBodyLimit }));

app.get("/healthz", async (_req, res) => {
  try {
    const health = await checkRpcHealth();
    const queueDepth = getSubmitQueueDepth();

    // Determine HTTP status code based on health status
    let statusCode = 200;
    if (health.status === "unhealthy") {
      statusCode = 503; // Service Unavailable
    } else if (health.status === "degraded") {
      statusCode = 200; // Still accept requests but indicate degradation
    }

    const pendingTxCount = getPendingTransactionCount();

    res.status(statusCode).json({
      status: health.status,
      rpc: health.rpc,
      contract: health.contract,
      timestamp: health.timestamp,
      queueDepth,
      pendingTransactions: pendingTxCount,
      ...(health.error && { error: health.error }),
    });
  } catch (err) {
    logger.error({ err }, "Health check failed");
    res.status(503).json({
      status: "unhealthy",
      error: "Health check failed",
      timestamp: new Date().toISOString(),
    });
  }
});

app.use("/api", registryRouter);
app.use("/api", agentsRouter);
app.use("/api", demoRouter);
app.use("/demo", servicesRouter);

app.use((err, _req, res, _next) => {
  if (err.type === "entity.too.large") {
    logger.warn({ expected: config.jsonBodyLimit }, "Request body too large");
    return res.status(413).json({
      error: `Request body too large. Maximum size is ${config.jsonBodyLimit}.`,
      code: "PAYLOAD_TOO_LARGE",
    });
  }

  logger.error({ err }, "Unhandled error");
  res.status(500).json({
    error: "Internal server error",
    code: "INTERNAL_ERROR",
  });
});
let server;
let shuttingDown = false;

async function start() {
  // Resume any pending transactions from a previous run before accepting requests
  try {
    await resumePendingTransactions();
  } catch (err) {
    logger.error({ err }, "Failed to resume pending transactions — continuing startup");
  }

  server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        network: config.stellar.network,
        contractId: config.contract.id,
      },
      "Lodestar backend running",
    );
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("Shutting down gracefully...");

  // Force-exit after the configured timeout so the process never hangs forever
  const forceExitTimer = setTimeout(() => {
    const pending = getPendingTransactions();
    if (pending.length > 0) {
      logger.warn(
        { count: pending.length, timeout: config.shutdownTimeoutMs },
        "Shutdown timeout reached — dumping pending transactions and force-exiting",
      );
      dumpPendingTransactions();
    }
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExitTimer.unref();

  // If server hasn't been created yet (signal during startup resume) skip close
  if (!server) {
    logger.warn("Server was not yet listening — draining queue directly");
    await doDrainAndDump();
    clearTimeout(forceExitTimer);
    process.exit(0);
    return;
  }

  // Stop accepting new connections
  server.close(async (closeErr) => {
    if (closeErr) {
      logger.error({ err: closeErr }, "Error closing HTTP server");
    } else {
      logger.info("HTTP server closed — no longer accepting new connections");
    }

    await doDrainAndDump();
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
}

async function doDrainAndDump() {
  try {
    await drainSubmitQueue();
    logger.info("Submit queue drained successfully");
  } catch (err) {
    logger.error({ err }, "Error draining submit queue");
  }

  const pending = getPendingTransactions();
  if (pending.length > 0) {
    logger.warn(
      { count: pending.length, hashes: pending.map((t) => t.hash) },
      "Pending transactions remain after queue drain — dumped to pending-transactions.json for manual verification",
    );
    dumpPendingTransactions();
  } else {
    logger.info("No pending transactions — clean shutdown");
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start();
