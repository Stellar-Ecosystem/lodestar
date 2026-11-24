import { Router } from "express";
import config from "../config.js";
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
import { isValidStellarAddress } from "../middleware/addressValidator.js";
import { withUpstreamTimeout } from "../lib/upstreamTimeout.js";
import { getCachedHealth, getHealthCacheStatus } from "../lib/healthCache.js";
import {
  getEntry,
  isValidIdempotencyKey,
  markComplete,
  markFailed,
  markPending,
} from "../lib/idempotency.js";
import { getRouteMetrics } from "../lib/routeMetrics.js";
import { getRouteLogger } from "../lib/routeLogger.js";

const router = Router();

const PAGE_SIZE = 20;
const SERVICE_CATEGORIES = new Set(["search", "weather", "finance", "ai", "data", "compute"]);
const PRICE_USDC_REGEX = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function normalizePriceUsdc(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const normalized = String(value);
    if (!PRICE_USDC_REGEX.test(normalized)) return null;
    return value >= 0.0001 ? normalized : null;
  }

  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized !== value || !PRICE_USDC_REGEX.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0.0001) {
    return null;
  }

  return normalized;
}

function parsePositiveSafeInteger(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// Appends ttl_warning:true when the entry's estimated remaining TTL falls
// below SERVICE_TTL_WARNING_LEDGERS. Omits the field entirely when currentLedger
// is unavailable so callers can always treat absence as "no warning data".
function parseFiniteNumericValue(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function annotateTtlWarning(service, currentLedger) {
  const parsedCurrentLedger = parseFiniteNumericValue(currentLedger);
  const registeredAt = parseFiniteNumericValue(service?.registered_at);

  if (parsedCurrentLedger === null || registeredAt === null) {
    return { ...service };
  }

  const expiryLedger = registeredAt + SERVICE_MAX_TTL;
  const warningOnset = expiryLedger - SERVICE_TTL_WARNING_LEDGERS;

  return {
    ...service,
    ttl_warning: parsedCurrentLedger >= warningOnset,
  };
}

router.get("/services", async (req, res) => {
  try {
    const { category, q, offset: offsetStr, limit: limitStr } = req.query;
    const offset = Math.max(0, parseInt(offsetStr, 10) || 0);
    const limit = Math.min(50, Math.max(1, parseInt(limitStr, 10) || PAGE_SIZE));

    const [servicesResult, ledgerResult] = await Promise.allSettled([
      listServices({ category: category || undefined, offset, limit }),
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
      const page = await listServices({ offset: i * PAGE_SIZE, limit: PAGE_SIZE });
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

router.get("/registry/by-provider/:address", async (req, res) => {
  try {
    const { address } = req.params;
    if (!isValidStellarAddress(address)) {
      return res.status(400).json({
        error: "Invalid Stellar address format",
        code: "INVALID_ADDRESS",
      });
    }

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

router.post("/registry/prepare-register", writeRateLimiter(), async (req, res) => {
  try {
    const {
      name,
      description,
      endpoint,
      priceUsdc,
      category,
      providerAddress,
      payTo,
    } = req.body ?? {};

    if (!isValidStellarAddress(providerAddress)) {
      return res.status(400).json({ error: "`providerAddress` must be a valid Stellar address", code: "INVALID_BODY" });
    }
    if (typeof name !== "string" || name.trim().length < 3 || name.trim().length > 64) {
      return res.status(400).json({ error: "`name` must be 3-64 characters", code: "INVALID_BODY" });
    }
    if (typeof description !== "string" || description.trim().length < 10 || description.trim().length > 256) {
      return res.status(400).json({ error: "`description` must be 10-256 characters", code: "INVALID_BODY" });
    }
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
      return res.status(400).json({ error: "`endpoint` must start with https://", code: "INVALID_BODY" });
    }
    if (endpoint.trim().length > 256) {
      return res.status(400).json({ error: "`endpoint` must be at most 256 characters", code: "INVALID_BODY" });
    }
    if (!SERVICE_CATEGORIES.has(category)) {
      return res.status(400).json({ error: "`category` is invalid", code: "INVALID_BODY" });
    }

    const normalizedPriceUsdc = normalizePriceUsdc(priceUsdc);
    if (!normalizedPriceUsdc) {
      return res.status(400).json({ error: "`priceUsdc` must be at least 0.0001", code: "INVALID_BODY" });
    }
    if (payTo !== undefined && (typeof payTo !== "string" || payTo.trim().length === 0)) {
      return res.status(400).json({ error: "`payTo` must be a non-empty string when provided", code: "INVALID_BODY" });
    }

    const prepared = await buildUnsignedRegistryTx("register", providerAddress, {
      name: name.trim(),
      description: description.trim(),
      endpoint: endpoint.trim(),
      priceUsdc: normalizedPriceUsdc,
      category,
      payTo: payTo?.trim(),
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

router.post("/registry/prepare-deactivate", writeRateLimiter(), async (req, res) => {
  try {
    const { providerAddress, id } = req.body ?? {};
    if (!isValidStellarAddress(providerAddress)) {
      return res.status(400).json({ error: "`providerAddress` must be a valid Stellar address", code: "INVALID_BODY" });
    }

    const parsedId = parsePositiveSafeInteger(id);
    if (parsedId == null) {
      return res.status(400).json({ error: "`id` must be a positive integer", code: "INVALID_BODY" });
    }

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

router.post("/registry/prepare-reactivate", writeRateLimiter(), async (req, res) => {
  try {
    const { providerAddress, id } = req.body ?? {};
    if (!isValidStellarAddress(providerAddress)) {
      return res.status(400).json({ error: "`providerAddress` must be a valid Stellar address", code: "INVALID_BODY" });
    }

    const parsedId = parsePositiveSafeInteger(id);
    if (parsedId == null) {
      return res.status(400).json({ error: "`id` must be a positive integer", code: "INVALID_BODY" });
    }

    const prepared = await buildUnsignedRegistryTx("reactivate", providerAddress, { id: parsedId });
    logger.info({ providerAddress, id: parsedId }, "Built unsigned registry reactivation tx");
    res.json(prepared);
  } catch (err) {
    if (err instanceof ContractError) {
      const status = err.code === "TRANSACTION_TIMEOUT" ? 504 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    logger.error({ err }, "POST /api/registry/prepare-reactivate failed");
    res.status(500).json({ error: "Failed to build transaction", code: "BUILD_TX_ERROR" });
  }
});

router.post("/registry/submit-signed-tx", writeRateLimiter(), async (req, res) => {
  try {
    const { signedXdr, submitToken } = req.body ?? {};
    if (!signedXdr || typeof signedXdr !== "string") {
      return res.status(400).json({ error: "`signedXdr` is required", code: "INVALID_BODY" });
    }
    if (!submitToken || typeof submitToken !== "string") {
      return res.status(400).json({ error: "`submitToken` is required", code: "INVALID_BODY" });
    }
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
// The vote is bounded by a deadline (REPUTATION_TIMEOUT_MS): on expiry the
// route answers 504 UPSTREAM_TIMEOUT so a hanging RPC node cannot hold
// connections open until the pool is exhausted (#671).
router.post("/reputation/:id", writeRateLimiter(), async (req, res) => {
  const startedAt = process.hrtime.bigint();
  const durationMs = () =>
    Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000);

  // One request-scoped logger for the whole handler: every line it emits
  // carries the request id, the route and the identifiers of this vote, so a
  // production failure can be reconstructed from the log alone (#670). The
  // request body is never logged — only the fields that identify the vote.
  const log = getRouteLogger(req, { route: "POST /api/reputation/:id" });

  // Exactly one structured line per request: the outcome and the duration
  // are attached by `finish`, so the success and the failure paths cannot
  // drift apart.
  const finish = (level, outcome, extra, status, payload) => {
    log[level]({ ...extra, outcome, durationMs: durationMs() }, "reputation vote processed");
    return res.status(status).json(payload);
  };

  let id;
  try {
    id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return finish("warn", "rejected", { serviceId: req.params.id }, 400, {
        error: "Invalid service ID",
        code: "INVALID_ID",
      });
    }

    // Default to {} so a missing/non-JSON body yields a 400 INVALID_BODY rather
    // than a TypeError surfacing as a generic 500.
    const { positive, agent } = req.body ?? {};
    if (typeof positive !== "boolean") {
      return finish("warn", "rejected", { serviceId: id }, 400, {
        error: "`positive` must be a boolean",
        code: "INVALID_BODY",
      });
    }
    if (!isValidStellarAddress(agent)) {
      return finish("warn", "rejected", { serviceId: id }, 400, {
        error: "`agent` must be a valid Stellar address",
        code: "INVALID_BODY",
      });
    }
    if (!isAllowedReputationAgent(agent)) {
      return finish("warn", "forbidden", { serviceId: id, agent }, 403, {
        error:
          "This agent is not permitted to vote through the hosted backend. Only registered demo agents may; other agents must submit a wallet-signed transaction.",
        code: "AGENT_NOT_ALLOWED",
      });
    }

    const newReputation = await withUpstreamTimeout(
      updateReputation(id, positive, agent),
      {
        timeoutMs: config.upstreamTimeout.reputationMs,
        label: "reputation",
      },
    );
    return finish(
      "info",
      "updated",
      { serviceId: id, agent, positive, newReputation },
      200,
      { success: true, newReputation },
    );
  } catch (err) {
    // SIMULATION_FAILED covers on-chain rejections such as the vote cooldown
    // or an unregistered agent — surface it as an actionable 400.
    if (err instanceof ContractError) {
      if (err.code === "AGENT_NOT_ALLOWED") {
        return finish("warn", "forbidden", { serviceId: id, code: err.code }, 403, {
          error: err.message,
          code: err.code,
        });
      }
      if (err.code === "TRANSACTION_TIMEOUT" || err.code === "UPSTREAM_TIMEOUT") {
        return finish("warn", "timeout", { serviceId: id, code: err.code }, 504, {
          error: err.message,
          code: err.code,
        });
      }
      return finish("warn", "contract_error", { serviceId: id, code: err.code }, 400, {
        error: err.message,
        code: err.code,
      });
    }
    return finish("error", "failed", { err, serviceId: id }, 500, {
      error: "Failed to update reputation",
      code: "UPDATE_ERROR",
    });
  }
});

/**
 * The liveness payload. Built at most once per cache TTL — see
 * {@link getCachedHealth}.
 */
function buildHealthPayload() {
  return {
    status: "ok",
    network: config.stellar.network,
    contractId: config.contract.id,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Send a health payload with its caching headers, honouring conditional
 * requests with 304.
 *
 * The ETag is computed over the exact bytes that are sent, so a client that
 * already holds the body can revalidate without downloading it again.
 */
function sendHealthResponse(req, res, body, etag, replayed) {
  res.set(
    "Cache-Control",
    `public, max-age=${config.health.cacheTtlSeconds}, must-revalidate`,
  );
  res.set("ETag", etag);
  if (replayed) {
    res.set("Idempotent-Replay", "true");
  }

  const ifNoneMatch = req.get("If-None-Match");
  if (
    ifNoneMatch
      ?.split(",")
      .map((value) => value.trim())
      .includes(etag)
  ) {
    return res.status(304).end();
  }

  return res.type("application/json").send(body);
}

/**
 * Liveness (#841).
 *
 * Deliberately dependency-free: it answers "is this process running?" and
 * nothing else. Touching RPC here would make an orchestrator restart a healthy
 * instance whose only problem is a slow upstream — use /api/ready for that.
 *
 * The payload changes far more slowly than it is read, so it is cached for a
 * few seconds (HEALTH_CACHE_TTL_SECONDS) and served with `Cache-Control` and
 * `ETag`: a conditional request is answered with 304 instead of a refetch
 * (#672). An `Idempotency-Key` makes a client retry replay the stored
 * response instead of re-executing the check (#673).
 */
router.get("/health", async (req, res) => {
  const idempotencyKey = req.get("idempotency-key") ?? req.get("x-idempotency-key");

  if (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey)) {
    return res.status(400).json({
      error:
        "Idempotency-Key must be 1-255 printable ASCII characters (no spaces)",
      code: "IDEMPOTENCY_KEY_INVALID",
    });
  }

  // Scope the key to this route so keys cannot collide with another route's.
  const scopedKey = idempotencyKey ? `health:${idempotencyKey}` : null;

  if (scopedKey) {
    const existing = getEntry(scopedKey);
    if (existing?.status === "pending") {
      return res.status(409).json({
        error: "A health check with this idempotency key is already in flight",
        code: "IDEMPOTENCY_CONFLICT",
      });
    }
    if (existing?.status === "complete") {
      logger.info({ idempotencyKey }, "Replaying idempotent health response");
      return sendHealthResponse(
        req,
        res,
        existing.result.body,
        existing.result.etag,
        true,
      );
    }
    if (existing?.status === "failed") {
      logger.info({ idempotencyKey }, "Replaying idempotent health error");
      return res.status(existing.result.httpStatus).json({
        error: existing.result.error,
        code: existing.result.code,
      });
    }
    markPending(scopedKey, config.health.idempotencyTtlSeconds * 1000);
  }

  try {
    const { body, etag } = await getCachedHealth(buildHealthPayload);
    if (scopedKey) {
      markComplete(scopedKey, { httpStatus: 200, body, etag });
    }
    return sendHealthResponse(req, res, body, etag, false);
  } catch (err) {
    if (scopedKey) {
      markFailed(scopedKey, {
        httpStatus: 500,
        error: "Health check failed",
        code: "HEALTH_ERROR",
      });
    }
    logger.error({ err }, "GET /api/health failed");
    res.status(500).json({ error: "Health check failed", code: "HEALTH_ERROR" });
  }
});

/**
 * Route counters: upstream timeouts (#671) and the health cache hit rate
 * (#672). Cheap to read, and the only way to tell "slow upstream" apart from
 * "cold cache" without reading logs.
 */
router.get("/metrics", (req, res) => {
  res.set("Cache-Control", "no-store");
  const metrics = getRouteMetrics();
  res.json({
    ...metrics,
    healthCache: { ...metrics.healthCache, ...getHealthCacheStatus() },
  });
});

/**
 * Readiness (#841).
 *
 * Checks the dependencies needed to actually serve traffic, each under a short
 * timeout. Returns 503 when a required dependency is unreachable so the
 * orchestrator stops routing here without restarting the process.
 */
router.get("/ready", async (req, res) => {
  const { checkReadiness } = await import("../lib/readiness.js");
  try {
    const result = await checkReadiness();
    res.status(result.ready ? 200 : 503).json(result);
  } catch (err) {
    logger.error({ err }, "GET /api/ready failed");
    res.status(503).json({
      ready: false,
      status: "not_ready",
      error: "Readiness check failed",
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
