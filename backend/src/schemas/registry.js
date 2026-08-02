/**
 * Request schemas for the registry routes (mounted at `/api`).
 *
 * Each export is a route spec: what the route is, and exactly what it accepts.
 * `validate()` enforces it at runtime and `lib/openapi.js` documents it — both
 * from this one declaration.
 */
import {
  z,
  SERVICE_CATEGORIES,
  intQueryParam,
  positiveIntegerField,
  priceUsdc,
  requiredString,
  serviceIdParam,
  signedXdrField,
  stellarAddress,
} from "./common.js";

export const basePath = "/api";
export const tags = ["registry"];

/** `:id` path param, shared by every per-service route. */
const serviceIdParams = {
  schema: z.object({ id: serviceIdParam() }),
  code: "INVALID_ID",
  message: "Invalid service ID",
};

/** `:address` path param for provider lookups. */
const providerAddressParams = {
  schema: z.object({ address: stellarAddress() }),
  code: "INVALID_ADDRESS",
};

export const listServices = {
  method: "get",
  path: "/services",
  summary: "List registry services, optionally filtered by category and text",
  request: {
    query: z.object({
      category: z
        .enum(SERVICE_CATEGORIES)
        .optional()
        .describe("Restrict results to one service category"),
      q: z
        .string()
        .optional()
        .describe("Case-insensitive substring matched against name and description"),
      offset: intQueryParam({ field: "offset", defaultValue: 0 }).describe(
        "Services to skip",
      ),
      limit: intQueryParam({
        field: "limit",
        min: 1,
        max: 50,
        defaultValue: 20,
      }).describe("Services per page; clamped to 50"),
    }),
  },
};

export const getService = {
  method: "get",
  path: "/services/:id",
  summary: "Fetch a single registry service by ID",
  request: { params: serviceIdParams },
};

export const deactivateService = {
  method: "post",
  path: "/services/:id/deactivate",
  summary: "Build an unsigned deactivation transaction for a service's provider",
  request: {
    params: serviceIdParams,
    body: z.object({
      providerAddress: stellarAddress(
        "`providerAddress` must be a valid Stellar address",
      ),
    }),
  },
};

export const getServiceHistory = {
  method: "get",
  path: "/services/:id/history",
  summary: "Fetch the reputation history of a service",
  request: { params: serviceIdParams },
};

export const getStats = {
  method: "get",
  path: "/stats",
  summary: "Aggregate registry statistics",
  request: {},
};

export const listByProvider = {
  method: "get",
  path: "/registry/by-provider/:address",
  summary: "List every service registered by one provider",
  request: { params: providerAddressParams },
};

export const prepareRegister = {
  method: "post",
  path: "/registry/prepare-register",
  summary: "Build an unsigned service-registration transaction",
  request: {
    // Key order is the reporting order: a caller fixing one field at a time
    // gets the same sequence of complaints the hand-rolled checks produced.
    body: z.object({
      providerAddress: stellarAddress(
        "`providerAddress` must be a valid Stellar address",
      ),
      name: requiredString("name", {
        min: 3,
        max: 64,
        description: "Human-readable service name",
      }),
      description: requiredString("description", {
        min: 10,
        max: 256,
        description: "What the service does",
      }),
      endpoint: z
        .string({ error: "`endpoint` must start with https://" })
        .trim()
        .startsWith("https://", { error: "`endpoint` must start with https://" })
        .describe("Public HTTPS URL the service is served from"),
      priceUsdc,
      category: z.enum(SERVICE_CATEGORIES, { error: "`category` is invalid" }),
      payTo: z
        .string({ error: "`payTo` must be a non-empty string when provided" })
        .trim()
        .min(1, { error: "`payTo` must be a non-empty string when provided" })
        .optional()
        .describe("Address that receives payments; defaults to the provider"),
    }),
  },
};

export const prepareDeactivate = {
  method: "post",
  path: "/registry/prepare-deactivate",
  summary: "Build an unsigned deactivation transaction from a service ID",
  request: {
    body: z.object({
      providerAddress: stellarAddress(
        "`providerAddress` must be a valid Stellar address",
      ),
      id: positiveIntegerField("id"),
    }),
  },
};

export const submitSignedTx = {
  method: "post",
  path: "/registry/submit-signed-tx",
  summary: "Submit a wallet-signed registry transaction",
  request: {
    body: z.object({
      signedXdr: signedXdrField(),
      submitToken: signedXdrField("submitToken").describe(
        "Token issued alongside the unsigned transaction",
      ),
    }),
  },
};

export const updateReputation = {
  method: "post",
  path: "/reputation/:id",
  summary: "Record a reputation vote for a service",
  request: {
    params: serviceIdParams,
    body: z.object({
      positive: z.boolean({ error: "`positive` must be a boolean" }),
      agent: stellarAddress("`agent` must be a valid Stellar address"),
    }),
  },
};

export const getHealth = {
  method: "get",
  path: "/health",
  summary: "Registry-scoped RPC and contract health",
  request: {},
};

export const routes = [
  listServices,
  getService,
  deactivateService,
  getServiceHistory,
  getStats,
  listByProvider,
  prepareRegister,
  prepareDeactivate,
  submitSignedTx,
  updateReputation,
  getHealth,
];
