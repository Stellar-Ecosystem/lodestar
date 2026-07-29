import { Router } from "express";
import {
  listServices,
  listServicesByProvider,
  getService,
  getServiceCount,
  deactivateServiceOnChain,
  updateReputation,
  isAllowedReputationAgent,
  buildUnsignedRegistryTx,
  validatePreparedRegistrySubmission,
  submitSignedRegistryTx,
  SERVICE_MAX_TTL,
  SERVICE_TTL_WARNING_LEDGERS,
} from "../lib/contract.js";
import { getCurrentLedgerSequence } from "../lib/stellar.js";
import { getReputationHistory } from "../lib/reputationHistory.js";
import logger from "../lib/logger.js";
import { ContractError } from "../lib/ContractError.js";
import { writeRateLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import * as schemas from "../schemas/registry.js";

const router = Router();

const PAGE_SIZE = 20;

// Appends ttl_warning:true when the entry's estimated remaining TTL falls
// below SERVICE_TTL_WARNING_LEDGERS. Omits the field entirely when currentLedger
// is unavailable so callers can always treat absence as "no warning data".
router.get("/services", validate(schemas.listServices), async (req, res) => {
  try {
    const { category, q, page } = req.valid.query;

    const [servicesResult, ledgerResult] = await Promise.allSettled([
      listServices({ category: category || undefined, page, pageSize: PAGE_SIZE }),
      getCurrentLedgerSequence(),
    ]);

    if (servicesResult.status === "rejected") throw servicesResult.reason;

    if (ledgerResult.status === "rejected") {
      logger.warn(
        { err: ledgerResult.reason },
        "Failed to fetch current ledger for TTL annotation on GET /api/services",
      );
    }

    const currentLedger =
      ledgerResult.status === "fulfilled" ? ledgerResult.value : null;

    let services = servicesResult.value.map((s) =>
      annotateTtlWarning(s, currentLedger),
    );

    if (q && q.trim()) {
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

router.get("/services/:id", validate(schemas.getService), async (req, res) => {
  try {
    const { id } = req.valid.params;

    const [serviceResult, ledgerResult] = await Promise.allSettled([
      getService(id),
      getCurrentLedgerSequence(),
    ]);

    if (serviceResult.status === "rejected") throw serviceResult.reason;

    const service = serviceResult.value;
    if (!service) {
      return res
        .status(404)
        .json({ error: "Service not found", code: "NOT_FOUND" });
    }

    if (ledgerResult.status === "rejected") {
      logger.warn(
        { err: ledgerResult.reason },
        "Failed to fetch current ledger for TTL annotation on GET /api/services/:id",
      );
    }

    const currentLedger =
      ledgerResult.status === "fulfilled" ? ledgerResult.value : null;
    res.json(annotateTtlWarning(service, currentLedger));
  } catch (err) {
    logger.error({ err }, "GET /api/services/:id failed");
    res.status(500).json({ error: "Failed to fetch service", code: "FETCH_ERROR" });
  }
});

/**
 * POST /api/services/:id/deactivate
 * Provider-authenticated deactivation. The caller must supply a valid
 * `providerAddress` that matches the service's registered provider.
 * The on-chain contract enforces `provider.require_auth()` so the returned
 * unsigned transaction must be signed by the provider's wallet (e.g.
 * Freighter) and submitted through POST /api/registry/submit-signed-tx.
 *
 * Body: { providerAddress: string }
 * Returns: { xdr, submitToken } — unsigned tx ready for wallet signing
 */
router.post("/services/:id/deactivate", writeRateLimiter(), validate(schemas.deactivateService), async (req, res) => {
  const { id: parsedId } = req.valid.params;

  try {
    const { providerAddress } = req.valid.body;

    const prepared = await deactivateServiceOnChain(parsedId, providerAddress);
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

router.get("/services/:id/history", validate(schemas.getServiceHistory), async (req, res) => {
  const { id } = req.valid.params;
  try {
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

router.get("/registry/by-provider/:address", validate(schemas.listByProvider), async (req, res) => {
  try {
    const { address } = req.valid.params;

    const [servicesResult, ledgerResult] = await Promise.allSettled([
      listServicesByProvider(address),
      getCurrentLedgerSequence(),
    ]);

    if (servicesResult.status === "rejected") throw servicesResult.reason;

    if (ledgerResult.status === "rejected") {
      logger.warn(
        { err: ledgerResult.reason },
        "Failed to fetch current ledger for TTL annotation on GET /api/registry/by-provider/:address",
      );
    }

    const currentLedger =
      ledgerResult.status === "fulfilled" ? ledgerResult.value : null;

    const services = servicesResult.value.map((s) =>
      annotateTtlWarning(s, currentLedger),
    );

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
    logger.error({ err, address: req.params.address }, "GET /api/registry/by-provider/:address failed");
    res.status(500).json({ error: "Failed to fetch services", code: "FETCH_ERROR" });
  }
});

router.post("/registry/prepare-register", writeRateLimiter(), validate(schemas.prepareRegister), async (req, res) => {
  try {
    // Already trimmed, normalised, and range-checked by the schema.
    const { name, description, endpoint, priceUsdc, category, providerAddress, payTo } =
      req.valid.body;

    const prepared = await buildUnsignedRegistryTx("register", providerAddress, {
      name,
      description,
      endpoint,
      priceUsdc,
      category,
      payTo,
    });
    logger.info({ providerAddress, endpoint, category }, "Built unsigned registry registration tx");
    res.json(prepared);
  } catch (err) {
    if (err instanceof ContractError) {
      const status = err.code === "TRANSACTION_TIMEOUT" ? 504 : err.code === "DUPLICATE_SERVICE" ? 409 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    logger.error({ err }, "POST /api/registry/prepare-register failed");
    res.status(500).json({ error: "Failed to build transaction", code: "BUILD_TX_ERROR" });
  }
});

router.post("/registry/prepare-deactivate", writeRateLimiter(), validate(schemas.prepareDeactivate), async (req, res) => {
  try {
    const { providerAddress, id: parsedId } = req.valid.body;

    const prepared = await buildUnsignedRegistryTx("deactivate", providerAddress, { id: parsedId });
    logger.info({ providerAddress, id: parsedId }, "Built unsigned registry deactivation tx");
    res.json(prepared);
  } catch (err) {
    if (err instanceof ContractError) {
      const status = err.code === "TRANSACTION_TIMEOUT" ? 504 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    logger.error({ err }, "POST /api/registry/prepare-deactivate failed");
    res.status(500).json({ error: "Failed to build transaction", code: "BUILD_TX_ERROR" });
  }
});

router.post("/registry/submit-signed-tx", writeRateLimiter(), validate(schemas.submitSignedTx), async (req, res) => {
  try {
    const { signedXdr, submitToken } = req.valid.body;
    validatePreparedRegistrySubmission(submitToken, signedXdr);

    const result = await submitSignedRegistryTx(signedXdr);
    logger.info({ hash: result.hash, id: result.id }, "Submitted wallet-signed registry tx");
    res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof ContractError) {
      const status = err.code === "TRANSACTION_TIMEOUT" ? 504 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    logger.error({ err }, "POST /api/registry/submit-signed-tx failed");
    res.status(500).json({ error: "Failed to submit transaction", code: "SUBMIT_TX_ERROR" });
  }
});

// POST /api/reputation/:id — Body: { positive: boolean, agent: string }
// `agent` must be a registered agent the backend is allowed to sign for. The
// on-chain contract enforces require_auth + agent registration + a per-agent
// cooldown, so reputation can no longer be moved by anonymous callers.
router.post("/reputation/:id", writeRateLimiter(), validate(schemas.updateReputation), async (req, res) => {
  const { id } = req.valid.params;
  try {
    const { positive, agent } = req.valid.body;

    if (!isAllowedReputationAgent(agent)) {
      return res.status(403).json({
        error:
          "This agent is not permitted to vote through the hosted backend. Only registered demo agents may; other agents must submit a wallet-signed transaction.",
        code: "AGENT_NOT_ALLOWED",
      });
    }

    const newReputation = await updateReputation(id, positive, agent);
    res.json({ success: true, newReputation });
  } catch (err) {
    // SIMULATION_FAILED covers on-chain rejections such as the vote cooldown
    // or an unregistered agent — surface it as an actionable 400.
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
