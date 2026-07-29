import { Router } from "express";
import { buildOpenApiDocument } from "../lib/openapi.js";

const router = Router();

// Generated once at boot: the schemas it reads are static module state, so
// there is nothing to recompute per request.
const document = buildOpenApiDocument();

/**
 * GET /api/openapi.json — the machine-readable API description, derived from
 * the same schemas `validate()` enforces.
 */
router.get("/openapi.json", (_req, res) => {
  res.json(document);
});

export default router;
