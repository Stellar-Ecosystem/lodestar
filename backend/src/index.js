import express from "express";
import cors from "cors";
import config from "./config.js";
import logger from "./lib/logger.js";
import { checkRpcHealth } from "./lib/stellar.js";
import { getSubmitQueueDepth, drainSubmitQueue, getSubmitQueuePending } from "./lib/contract.js";
import { globalRateLimiter, readRateLimiter } from "./middleware/rateLimiter.js";
import { adminAuth } from "./middleware/adminAuth.js";
import { getRegistrationsByIpSnapshot } from "./routes/registry.js";
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

// Global per-IP rate limiter (applied before any route handlers).
app.use(globalRateLimiter());

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

    res.status(statusCode).json({
      status: health.status,
      rpc: health.rpc,
      contract: health.contract,
      timestamp: health.timestamp,
      queueDepth,
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

// Apply read-rate-limiter to simulation-heavy read routes.
app.use("/api", readRateLimiter());

app.use("/api", registryRouter);
app.use("/api", agentsRouter);
app.use("/api", demoRouter);
app.use("/demo", servicesRouter);

// GET /api/admin/quota-status — admin-only visibility into multi-tenancy state
app.get("/api/admin/quota-status", adminAuth, (_req, res) => {
  const registrationsByIp = getRegistrationsByIpSnapshot();
  const perIpCounts = Object.fromEntries(registrationsByIp);
  res.json({
    registrationsByIp: perIpCounts,
    queueDepth: getSubmitQueuePending(),
    queuePending: getSubmitQueuePending(),
    timestamp: new Date().toISOString(),
  });
});

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


const server = app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      network: config.stellar.network,
      contractId: config.contract.id,
    },
    "Lodestar backend running",
  );
});

async function shutdown() {
  logger.info("Shutting down gracefully...");
  server.close(async () => {
    logger.info("HTTP server closed.");
    try {
      await drainSubmitQueue();
      logger.info("Submit queue drained.");
    } catch (err) {
      logger.error({ err }, "Error draining submit queue");
    }
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
