import { Router } from "express";
import {
  listServices,
  getService,
  getServiceCount,
  updateReputation,
} from "../lib/contract.js";
import { getReputationHistory } from "../lib/reputationHistory.js";
import logger from "../lib/logger.js";
import { ContractError } from "../lib/ContractError.js";
import { writeRateLimiter } from "../middleware/rateLimiter.js";

const router = Router();

const PAGE_SIZE = 20;

router.get("/services", async (req, res) => {
  try {
    const { category, q, page: pageStr } = req.query;
    const page = Math.max(0, parseInt(pageStr, 10) || 0);
    let services = await listServices({
      category: category || undefined,
      page,
      pageSize: PAGE_SIZE,
    });

    if (q && typeof q === "string" && q.trim()) {
      const query = q.trim().toLowerCase();
      services = services.filter(
        (s) =>
          (s.name && s.name.toLowerCase().includes(query)) ||
          (s.description && s.description.toLowerCase().includes(query)),
      );
    }

    res.json({ services, count: services.length });
  } catch (err) {
    if (err instanceof ContractError) {
      if (err.code === "SIMULATION_FAILED") {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      if (err.code === "TRANSACTION_TIMEOUT") {
        return res.status(504).json({ error: err.message, code: err.code });
      }
    }
    logger.error({ err }, "GET /api/services failed");
    res.status(500).json({ error: "Failed to fetch services", code: "FETCH_ERROR" });
  }
});

router.get("/services/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res
        .status(400)
        .json({ error: "Invalid service ID", code: "INVALID_ID" });
    }
    const service = await getService(id);
    if (!service) {
      return res
        .status(404)
        .json({ error: "Service not found", code: "NOT_FOUND" });
    }
    res.json(service);
  } catch (err) {
    logger.error({ err }, "GET /api/services/:id failed");
    res.status(500).json({ error: "Failed to fetch service", code: "FETCH_ERROR" });
  }
});

router.get("/services/:id/history", async (req, res) => {
  let id;
  try {
    id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res
        .status(400)
        .json({ error: "Invalid service ID", code: "INVALID_ID" });
    }
    const service = await getService(id);
    if (!service) {
      return res
        .status(404)
        .json({ error: "Service not found", code: "NOT_FOUND" });
    }
    const history = getReputationHistory(id);
    res.json({ history });
  } catch (err) {
    logger.error({ err, id }, "GET /api/services/:id/history failed");
    res.status(500).json({ error: "Failed to fetch reputation history", code: "FETCH_ERROR" });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const totalServices = await getServiceCount();
    const totalPages = Math.ceil(totalServices / PAGE_SIZE);
    let allServices = [];
    for (let i = 0; i < totalPages; i++) {
      const page = await listServices({ page: i, pageSize: PAGE_SIZE });
      allServices.push(...page);
    }

    const categories = [...new Set(allServices.map((s) => s.category))];
    const latestService = allServices.reduce(
      (latest, s) =>
        s.registered_at > (latest?.registered_at ?? 0) ? s : latest,
      null,
    );

    res.json({ totalServices, categories, latestService });
  } catch (err) {
    logger.error({ err }, "GET /api/stats failed");
    res.status(500).json({ error: "Failed to fetch stats", code: "FETCH_ERROR" });
  }
});

router.post("/reputation/:id", writeRateLimiter(), async (req, res) => {
  let id;
  try {
    id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res
        .status(400)
        .json({ error: "Invalid service ID", code: "INVALID_ID" });
    }

    const { positive } = req.body;
    if (typeof positive !== "boolean") {
      return res
        .status(400)
        .json({ error: "`positive` must be a boolean", code: "INVALID_BODY" });
    }

    const newReputation = await updateReputation(id, positive);
    res.json({ success: true, newReputation });
  } catch (err) {
    logger.error({ err, id }, "POST /api/reputation/:id failed");
    res.status(500).json({ error: "Failed to update reputation", code: "UPDATE_ERROR" });
  }
});

router.get("/health", async (req, res) => {
  const { default: config } = await import("../config.js");
  const { checkRpcHealth } = await import("../lib/stellar.js");
  try {
    const health = await checkRpcHealth();
    res.json({
      status: health.status,
      network: config.stellar.network,
      contractId: config.contract.id,
      rpc: health.rpc,
      contract: health.contract,
      timestamp: new Date().toISOString(),
      ...(health.error && { error: health.error }),
    });
  } catch (err) {
    logger.error({ err }, "GET /api/health failed");
    res.status(500).json({
      status: "unhealthy",
      error: "Health check failed",
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
