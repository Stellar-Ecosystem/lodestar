import { Router } from "express";
import logger from "../lib/logger.js";
import { ContractError } from "../lib/ContractError.js";
import { writeRateLimiter } from "../middleware/rateLimiter.js";
import { isValidStellarAddress } from "../middleware/addressValidator.js";
import {
  parsePositiveSafeInteger,
  validateRegisterBody,
  validateDeactivateBody,
  validateSubmitSignedTxBody,
  validateReputationBody,
  ValidationError,
} from "../lib/registryValidation.js";
import {
  listServicesWithTtl,
  getServiceWithTtl,
  listServicesByProviderWithTtl,
  getStats as fetchStats,
  deactivateService,
  prepareRegister,
  prepareDeactivate,
  submitSignedTx,
  castReputationVote,
  getServiceHistory,
} from "../lib/registryService.js";

const router = Router();

// ── GET /services ─────────────────────────────────────────────────────

router.get("/services", async (req, res) => {
  try {
    const { category, q, page: pageStr } = req.query;
    const page = Math.max(0, parseInt(pageStr, 10) || 0);

    const result = await listServicesWithTtl({ category, q, page });
    res.json(result);
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

// ── GET /services/:id ─────────────────────────────────────────────────

router.get("/services/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res
        .status(400)
        .json({ error: "Invalid service ID", code: "INVALID_ID" });
    }

    const service = await getServiceWithTtl(id);
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

// ── POST /services/:id/deactivate ─────────────────────────────────────

router.post("/services/:id/deactivate", writeRateLimiter(), async (req, res) => {
  const parsedId = parsePositiveSafeInteger(req.params.id);
  if (parsedId == null) {
    return res
      .status(400)
      .json({ error: "Invalid service ID", code: "INVALID_ID" });
  }

  try {
    const { providerAddress } = req.body ?? {};
    if (!isValidStellarAddress(providerAddress)) {
      return res.status(400).json({
        error: "`providerAddress` must be a valid Stellar address",
        code: "INVALID_BODY",
      });
    }

    const prepared = await deactivateService(parsedId, providerAddress);
    logger.info({ id: parsedId, providerAddress }, "Built unsigned deactivation tx");
    res.json(prepared);
  } catch (err) {
    if (err instanceof ContractError) {
      if (err.code === "SERVICE_NOT_FOUND") {
        return res.status(404).json({ error: err.message, code: err.code });
      }
      if (err.code === "SERVICE_READ_FAILED") {
        return res.status(502).json({ error: err.message, code: err.code });
      }
      if (err.code === "PROVIDER_MISMATCH") {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      if (err.code === "ALREADY_INACTIVE") {
        return res.status(409).json({ error: err.message, code: err.code });
      }
      if (err.code === "TRANSACTION_TIMEOUT") {
        return res.status(504).json({ error: err.message, code: err.code });
      }
      return res.status(400).json({ error: err.message, code: err.code });
    }
    logger.error({ err, id: parsedId }, "POST /api/services/:id/deactivate failed");
    res.status(500).json({
      error: "Failed to deactivate service",
      code: "DEACTIVATE_ERROR",
    });
  }
});

// ── GET /services/:id/history ──────────────────────────────────────────

router.get("/services/:id/history", async (req, res) => {
  let id;
  try {
    id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res
        .status(400)
        .json({ error: "Invalid service ID", code: "INVALID_ID" });
    }
    const result = await getServiceHistory(id);
    if (!result) {
      return res
        .status(404)
        .json({ error: "Service not found", code: "NOT_FOUND" });
    }
    res.json({ history: result.history });
  } catch (err) {
    logger.error({ err, id }, "GET /api/services/:id/history failed");
    res.status(500).json({ error: "Failed to fetch reputation history", code: "FETCH_ERROR" });
  }
});

// ── GET /stats ────────────────────────────────────────────────────────

router.get("/stats", async (req, res) => {
  try {
    const stats = await fetchStats();
    res.json(stats);
  } catch (err) {
    logger.error({ err }, "GET /api/stats failed");
    res.status(500).json({ error: "Failed to fetch stats", code: "FETCH_ERROR" });
  }
});

// ── GET /registry/by-provider/:address ────────────────────────────────

router.get("/registry/by-provider/:address", async (req, res) => {
  try {
    const { address } = req.params;
    if (!isValidStellarAddress(address)) {
      return res.status(400).json({
        error: "Invalid Stellar address format",
        code: "INVALID_ADDRESS",
      });
    }

    const result = await listServicesByProviderWithTtl(address);
    res.json(result);
  } catch (err) {
    if (err instanceof ContractError) {
      if (err.code === "SIMULATION_FAILED") {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      if (err.code === "TRANSACTION_TIMEOUT") {
        return res.status(504).json({ error: err.message, code: err.code });
      }
    }
    logger.error({ err, address: req.params.address }, "GET /api/registry/by-provider/:address failed");
    res.status(500).json({ error: "Failed to fetch services", code: "FETCH_ERROR" });
  }
});

// ── POST /registry/prepare-register ───────────────────────────────────

router.post("/registry/prepare-register", writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body ?? {};
    const validated = validateRegisterBody(body);

    const prepared = await prepareRegister(validated.providerAddress, {
      name: validated.name,
      description: validated.description,
      endpoint: validated.endpoint,
      priceUsdc: validated.priceUsdc,
      category: validated.category,
      payTo: validated.payTo,
    });
    logger.info(
      { providerAddress: validated.providerAddress, endpoint: validated.endpoint, category: validated.category },
      "Built unsigned registry registration tx",
    );
    res.json(prepared);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err instanceof ContractError) {
      const status = err.code === "TRANSACTION_TIMEOUT" ? 504 : err.code === "DUPLICATE_SERVICE" ? 409 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    logger.error({ err }, "POST /api/registry/prepare-register failed");
    res.status(500).json({ error: "Failed to build transaction", code: "BUILD_TX_ERROR" });
  }
});

// ── POST /registry/prepare-deactivate ─────────────────────────────────

router.post("/registry/prepare-deactivate", writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body ?? {};
    const validated = validateDeactivateBody(body);

    const prepared = await prepareDeactivate(validated.providerAddress, validated.id);
    logger.info(
      { providerAddress: validated.providerAddress, id: validated.id },
      "Built unsigned registry deactivation tx",
    );
    res.json(prepared);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err instanceof ContractError) {
      const status = err.code === "TRANSACTION_TIMEOUT" ? 504 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    logger.error({ err }, "POST /api/registry/prepare-deactivate failed");
    res.status(500).json({ error: "Failed to build transaction", code: "BUILD_TX_ERROR" });
  }
});

// ── POST /registry/submit-signed-tx ───────────────────────────────────

router.post("/registry/submit-signed-tx", writeRateLimiter(), async (req, res) => {
  try {
    const body = req.body ?? {};
    const validated = validateSubmitSignedTxBody(body);

    const result = await submitSignedTx(validated.signedXdr, validated.submitToken);
    logger.info({ hash: result.hash, id: result.id }, "Submitted wallet-signed registry tx");
    res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err instanceof ContractError) {
      const status = err.code === "TRANSACTION_TIMEOUT" ? 504 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    logger.error({ err }, "POST /api/registry/submit-signed-tx failed");
    res.status(500).json({ error: "Failed to submit transaction", code: "SUBMIT_TX_ERROR" });
  }
});

// ── POST /reputation/:id ──────────────────────────────────────────────

router.post("/reputation/:id", writeRateLimiter(), async (req, res) => {
  let id;
  try {
    id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res
        .status(400)
        .json({ error: "Invalid service ID", code: "INVALID_ID" });
    }

    const body = req.body ?? {};
    const validated = validateReputationBody(body);

    const newReputation = await castReputationVote(id, validated.positive, validated.agent);
    res.json({ success: true, newReputation });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err instanceof ContractError) {
      if (err.code === "AGENT_NOT_ALLOWED") {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      if (err.code === "TRANSACTION_TIMEOUT") {
        return res.status(504).json({ error: err.message, code: err.code });
      }
      return res.status(400).json({ error: err.message, code: err.code });
    }
    logger.error({ err, id }, "POST /api/reputation/:id failed");
    res.status(500).json({ error: "Failed to update reputation", code: "UPDATE_ERROR" });
  }
});

// ── GET /health ───────────────────────────────────────────────────────

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
