import express from "express";
import cors from "cors";
import config from "./config.js";
import logger from "./lib/logger.js";
import { checkRpcHealth } from "./lib/stellar.js";
import registryRouter from "./routes/registry.js";
import servicesRouter from "./routes/services.js";
import demoRouter from "./routes/demo.js";
import agentsRouter from "./routes/agents.js";

const app = express();

if (!config.contract.agentsId) {
  logger.warn(
    'AGENTS_CONTRACT_ID is not set; agent credit scoring routes will return AGENTS_NOT_CONFIGURED until the agents contract is deployed'
  );
}

app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: config.jsonBodyLimit }));

app.get("/healthz", async (_req, res) => {
  try {
    const health = await checkRpcHealth();

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

app.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      network: config.stellar.network,
      contractId: config.contract.id,
    },
    "Lodestar backend running",
  );
});
