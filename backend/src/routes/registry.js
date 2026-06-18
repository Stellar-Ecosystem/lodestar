import { Router } from "express";
import {
  listServices,
  getService,
  getServiceCount,
  updateReputation,


const router = Router();

router.get("/services", async (req, res) => {
  try {
    const { category, q } = req.query;
    let services = await listServices(category || undefined);

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

  }
});

router.get("/stats", async (req, res) => {
  try {
    const [services, totalServices] = await Promise.all([
      listServices(),
      getServiceCount(),
    ]);

    const categories = [...new Set(services.map((s) => s.category))];
    const latestService = services.reduce(
      (latest, s) =>
        s.registered_at > (latest?.registered_at ?? 0) ? s : latest,
      null,
    );

    res.json({ totalServices, categories, latestService });
  } catch (err) {

  }
});

router.post("/reputation/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
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

  }
});

router.get("/health", async (req, res) => {
  const { default: config } = await import("../config.js");
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
