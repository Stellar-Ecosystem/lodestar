/**
 * Request schemas for the agent routes (mounted at `/api`).
 */
import {
  z,
  floatQueryParam,
  idempotencyKeyHeader,
  intQueryParam,
  positiveIntegerField,
  requiredString,
  signedXdrField,
  stellarAddress,
  stroopsField,
  usdcAmountField,
} from "./common.js";

export const basePath = "/api";
export const tags = ["agents"];

/** `:address` path param shared by every per-agent route. */
const agentAddressParams = {
  schema: z.object({ address: stellarAddress() }),
  code: "INVALID_ADDRESS",
};

/**
 * The spending-policy body, identical on the three routes that set one.
 * Declaring it once is the point of the exercise: previously the same four
 * checks were copy-pasted into `build-tx`, `update-policy`, and `PUT /policy`.
 */
const policyBody = z.object({
  maxPerTxStroops: stroopsField("maxPerTxStroops"),
  maxPerDayStroops: stroopsField("maxPerDayStroops"),
  allowedCategories: z
    .array(z.string(), { error: "`allowedCategories` must be an array of strings" })
    .describe("Service categories this agent may pay for; empty means all"),
  minScoreToEarn: z
    .number({ error: "`minScoreToEarn` must be a number" })
    .describe("Minimum reputation score before the agent earns"),
});

/** Free-text justification attached to a flag. */
const reasonBody = z.object({
  reason: requiredString("reason", { description: "Why the agent is being flagged" }),
});

export const listAgents = {
  method: "get",
  path: "/agents",
  summary: "List registered agents, paginated and sorted",
  request: {
    query: z.object({
      page: intQueryParam({ field: "page", defaultValue: 0 }).describe(
        "Zero-based page index",
      ),
      pageSize: intQueryParam({
        field: "pageSize",
        min: 1,
        max: 100,
        defaultValue: 12,
      }).describe("Agents per page; clamped to 100"),
      sort: z
        .enum(["score", "payments", "newest"])
        .optional()
        .default("score")
        .describe("Ordering applied before pagination"),
    }),
  },
};

export const getAgentCount = {
  method: "get",
  path: "/agents/count",
  summary: "Total number of registered agents",
  request: {},
};

export const getAgentStats = {
  method: "get",
  path: "/agents/stats",
  summary: "Aggregate agent statistics",
  request: {},
};

export const registerAgent = {
  method: "post",
  path: "/agents/register",
  summary: "Register an agent on-chain",
  request: {
    body: z.object({
      agentAddress: stellarAddress(),
      name: requiredString("name", {
        min: 3,
        max: 64,
        description: "Human-readable agent name",
      }),
      description: requiredString("description", {
        min: 10,
        max: 256,
        description: "What the agent does",
      }),
    }),
  },
};

export const getAgentByAddress = {
  method: "get",
  path: "/agents/:address",
  summary: "Fetch an agent and its spending policy",
  request: { params: agentAddressParams },
};

export const getAgentPolicy = {
  method: "get",
  path: "/agents/:address/policy",
  summary: "Fetch an agent's spending policy",
  request: { params: agentAddressParams },
};

export const getAgentScore = {
  method: "get",
  path: "/agents/:address/score",
  summary: "Fetch an agent's reputation score",
  request: { params: agentAddressParams },
};

export const getAgentEligibility = {
  method: "get",
  path: "/agents/:address/eligible",
  summary: "Check an agent's score against a threshold",
  request: {
    params: agentAddressParams,
    query: z.object({
      min_score: intQueryParam({ field: "min_score", defaultValue: 0 }).describe(
        "Score the agent must meet or exceed",
      ),
    }),
  },
};

export const getAgentCanSpend = {
  method: "get",
  path: "/agents/:address/can-spend",
  summary: "Check a prospective payment against the agent's policy",
  request: {
    params: agentAddressParams,
    query: z.object({
      amount: floatQueryParam({
        field: "amount",
        min: 0,
        defaultValue: 0,
        message: "`amount` must be a non-negative number of USDC",
      }).describe("Payment amount in USDC"),
      category: z
        .string()
        .optional()
        .default("")
        .describe("Service category the payment is for"),
    }),
  },
};

export const recordPayment = {
  method: "post",
  path: "/agents/:address/payment",
  summary: "Record a completed payment against an agent",
  request: {
    params: agentAddressParams,
    headers: {
      schema: z.object({ "x-idempotency-key": idempotencyKeyHeader }),
      code: "IDEMPOTENCY_KEY_MISSING",
    },
    body: z.object({
      amountUsdc: usdcAmountField("amountUsdc"),
      success: z.boolean({ error: "`success` must be boolean" }),
      serviceId: positiveIntegerField("serviceId"),
    }),
  },
};

export const getPaymentHistory = {
  method: "get",
  path: "/agents/:address/payment-history",
  summary: "Paginated payment history for one agent",
  request: {
    params: agentAddressParams,
    query: {
      schema: z.object({
        limit: intQueryParam({
          field: "limit",
          min: 1,
          max: 50,
          defaultValue: 20,
          message: "`limit` must be a positive integer",
        }).describe("Entries per page; clamped to 50"),
        offset: intQueryParam({
          field: "offset",
          defaultValue: 0,
          message: "`offset` must be a non-negative integer",
        }).describe("Entries to skip"),
      }),
      code: "INVALID_PAGINATION",
    },
  },
};

export const checkSpending = {
  method: "get",
  path: "/agents/:address/check",
  summary: "Legacy spending check taking a raw stroops amount",
  request: {
    params: agentAddressParams,
    query: z.object({
      amount: intQueryParam({
        field: "amount",
        defaultValue: 0,
        message: "`amount` must be a non-negative integer of stroops",
      }).describe("Payment amount in stroops"),
    }),
  },
};

export const buildAgentTx = {
  method: "post",
  path: "/agents/:address/build-tx",
  summary: "Build an unsigned owner-authorised agent transaction",
  request: {
    params: agentAddressParams,
    // The body's required fields depend on `action`, so the two shapes are
    // declared as a discriminated union rather than checked after the fact.
    body: z.discriminatedUnion(
      "action",
      [
        z.object({ action: z.literal("deactivate") }),
        z.object({ action: z.literal("update_policy") }).extend(policyBody.shape),
      ],
      { error: "`action` must be deactivate or update_policy" },
    ),
  },
};

export const submitSignedAgentTx = {
  method: "post",
  path: "/agents/:address/submit-signed-tx",
  summary: "Submit a wallet-signed agent transaction",
  request: {
    params: agentAddressParams,
    body: z.object({ signedXdr: signedXdrField() }),
  },
};

export const flagAgent = {
  method: "post",
  path: "/agents/:address/flag",
  summary: "Flag an agent (legacy admin route)",
  request: { params: agentAddressParams, body: reasonBody },
};

export const adminFlagAgent = {
  method: "post",
  path: "/admin/agents/:address/flag",
  summary: "Flag an agent",
  request: { params: agentAddressParams, body: reasonBody },
};

export const adminDeactivateAgent = {
  method: "post",
  path: "/admin/agents/:address/deactivate",
  summary: "Deactivate an agent",
  request: { params: agentAddressParams },
};

export const deactivateAgent = {
  method: "post",
  path: "/agents/:address/deactivate",
  summary: "Deactivate an agent as its owner",
  request: { params: agentAddressParams },
};

export const updateAgentPolicy = {
  method: "post",
  path: "/agents/:address/update-policy",
  summary: "Replace an agent's spending policy",
  request: { params: agentAddressParams, body: policyBody },
};

export const putAgentPolicy = {
  method: "put",
  path: "/agents/:address/policy",
  summary: "Replace an agent's spending policy",
  request: { params: agentAddressParams, body: policyBody },
};

export const routes = [
  listAgents,
  getAgentCount,
  getAgentStats,
  registerAgent,
  getAgentByAddress,
  getAgentPolicy,
  getAgentScore,
  getAgentEligibility,
  getAgentCanSpend,
  recordPayment,
  getPaymentHistory,
  checkSpending,
  buildAgentTx,
  submitSignedAgentTx,
  flagAgent,
  adminFlagAgent,
  adminDeactivateAgent,
  deactivateAgent,
  updateAgentPolicy,
  putAgentPolicy,
];
