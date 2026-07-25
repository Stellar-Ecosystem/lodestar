import { Router } from 'express';
import {
  listAgentsPage,
  getAgent,
  getAgentPolicy,
  getAgentScore,
  getAgentCount,
  registerAgentOnChain,
  recordPaymentOnChain,
  checkSpendingAllowed,
  isAgentEligible,
  flagAgentOnChain,
  deactivateAgentOnChain,
  adminDeactivateAgentOnChain,
  updatePolicyOnChain,
  buildUnsignedAgentTx,
  submitSignedAgentTx,
  isAgentRegistered,
} from '../lib/contract.js';
import config from '../config.js';
import { ownerAuth } from '../middleware/ownerAuth.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { hmacAuth } from '../middleware/hmacAuth.js';
import { paymentRateLimiter } from '../middleware/paymentRateLimiter.js';
import { writeRateLimiter } from '../middleware/rateLimiter.js';
import { validateAgentAddressParam, isValidStellarAddress } from '../middleware/addressValidator.js';
import logger from '../lib/logger.js';
import { handleContractError } from '../lib/ContractError.js';
import {
  isValidIdempotencyKey,
  getEntry,
  markPending,
  markComplete,
  markFailed,
} from '../lib/idempotency.js';
import { getActivityFeed, parseActivityPagination } from '../lib/activityFeed.js';

const router = Router();

// In-memory cache
let agentsCache = null;
let agentsCacheTime = 0;
const AGENTS_CACHE_TTL = 30_000;
const CACHE_BATCH_SIZE = 50;

async function getCachedAgents() {
  const now = Date.now();
  if (agentsCache && now - agentsCacheTime < AGENTS_CACHE_TTL) return agentsCache;

  const total = await getAgentCount();
  const pages = Math.ceil(total / CACHE_BATCH_SIZE);
  const results = [];
  for (let i = 0; i < pages; i++) {
    const batch = await listAgentsPage(i, CACHE_BATCH_SIZE);
    results.push(...batch);
  }

  agentsCache = results;
  agentsCacheTime = now;
  return agentsCache;
}

function sortAgents(agents, sort) {
  return [...agents].sort((a, b) => {
    if (sort === 'score') return b.score - a.score;
    if (sort === 'payments') return Number(b.total_payments) - Number(a.total_payments);
    return Number(b.registered_at) - Number(a.registered_at);
  });
}

function requireAgentsContract(_req, res, next) {
  if (!config.contract.agentsId) {
    return res.status(503).json({
      error: 'Agents contract not yet deployed. Set AGENTS_CONTRACT_ID in .env',
      code: 'AGENTS_NOT_CONFIGURED',
    });
  }
  next();
}

// GET /api/agents
router.get('/agents', requireAgentsContract, async (req, res) => {
  try {
    const parsedPage = Number.parseInt(String(req.query.page ?? '0'), 10);
    const parsedPageSize = Number.parseInt(String(req.query.pageSize ?? '12'), 10);
    const page = Number.isFinite(parsedPage) ? Math.max(0, parsedPage) : 0;
    const pageSize = Number.isFinite(parsedPageSize) ? Math.min(100, Math.max(1, parsedPageSize)) : 12;
    const sort = ['score', 'payments', 'newest'].includes(req.query.sort)
      ? req.query.sort
      : 'score';

    const allAgents = await getCachedAgents();
    const sorted = sortAgents(allAgents, sort);
    const total = sorted.length;
    const agents = sorted.slice(page * pageSize, (page + 1) * pageSize);

    res.json({ agents, total, page, pageSize });
  } catch (err) {
    logger.error({ err }, 'GET /api/agents failed');
    return handleContractError(err, res, 'Failed to fetch agents', 'FETCH_ERROR');
  }
});

// POST /api/agents/register
router.post('/agents/register', requireAgentsContract, writeRateLimiter(), async (req, res) => {
  try {
    const { agentAddress, name, description, maxPerTxUsdc, maxPerDayUsdc, allowedCategories } = req.body;

    if (!agentAddress || typeof agentAddress !== 'string') {
      return res.status(400).json({ error: '`agentAddress` is required', code: 'INVALID_BODY' });
    }
    if (!isValidStellarAddress(agentAddress)) {
      return res.status(400).json({ error: 'Invalid Stellar address format', code: 'INVALID_BODY' });
    }
    if (!name || typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 64) {
      return res.status(400).json({ error: '`name` must be 3–64 characters', code: 'INVALID_BODY' });
    }
    if (!description || typeof description !== 'string' || description.trim().length < 10 || description.trim().length > 256) {
      return res.status(400).json({ error: '`description` must be 10–256 characters', code: 'INVALID_BODY' });
    }

    const isRegistered = await isAgentRegistered(agentAddress);
    if (isRegistered) {
      logger.info({ agentAddress }, 'Attempted to register an already registered agent');
      return res.status(409).json({ error: 'Agent already registered', code: 'ALREADY_EXISTS', agentAddress });
    }

    const count = await registerAgentOnChain(agentAddress, name.trim(), description.trim());

    // Apply custom policy if supplied
    if (maxPerTxUsdc !== undefined || maxPerDayUsdc !== undefined || allowedCategories !== undefined) {
      await updatePolicyOnChain(agentAddress, {
        maxPerTxUsdc: maxPerTxUsdc ?? 10,
        maxPerDayUsdc: maxPerDayUsdc ?? 100,
        allowedCategories: Array.isArray(allowedCategories) ? allowedCategories : [],
      });
    }

    agentsCache = null;
    logger.info({ agentAddress, name }, 'Agent registered on-chain');
    res.status(201).json({ success: true, agentCount: count, agentAddress });
  } catch (err) {
    logger.error({ err }, 'POST /api/agents/register failed');
    if (err.message?.includes('already registered')) {
      return res.status(409).json({ error: 'Agent already registered', code: 'ALREADY_EXISTS', agentAddress });
    }
    return handleContractError(err, res, 'Registration failed', 'REGISTER_ERROR');
  }
});

// GET /api/agents/:address/payment-history
router.get('/agents/:address/payment-history', requireAgentsContract, async (req, res) => {
  try {
    const { address } = req.params;
    const { limit, offset, errors } = parseActivityPagination(req.query);

    if (errors.length > 0) {
      logger.warn({ query: req.query, errors, address }, 'Invalid payment-history pagination params');
      return res.status(400).json({
        code: 'INVALID_PAGINATION',
        errors, // return as array
      });
    }

    const feed = getActivityFeed();
    const payments = feed.filter(
      (entry) => entry.agent === address && typeof entry.txHash === 'string' && entry.txHash.length > 0
    );

    const total = payments.length;
    const items = payments.slice(offset, offset + limit);
    const hasMore = offset + items.length < total;

    logger.info({ address, limit, offset, total, returned: items.length }, 'Payment history served');
    return res.json({
      payments: items,
      pagination: { total, limit, offset, hasMore },
    });
  } catch (err) {
    logger.error({ err, address: req.params.address }, 'GET /api/agents/:address/payment-history failed');
    return handleContractError(err, res, 'Failed to fetch payment history', 'FETCH_ERROR');
  }
});

/*
  The following admin routes and other agent-related endpoints are included below.
  They are implemented to match the contract helpers and middleware used above.
  - POST /admin/agents/:address/flag
  - POST /admin/agents/:address/deactivate
  - POST /agents/:address/policy (owner-authenticated policy updates)
  - POST /agents/:address/unsigned-tx (build unsigned agent tx)
  - POST /agents/submit-signed-tx (submit signed agent tx)
  - GET /agents/:address (get agent details)
  - GET /agents/:address/policy (get agent policy)
  - GET /agents/:address/score (get agent score)
  - GET /agents/count (get agent count)
*/

router.post(
  '/admin/agents/:address/flag',
  adminAuth,
  writeRateLimiter(),
  validateAgentAddressParam('address'),
  async (req, res) => {
    try {
      const { address } = req.params;
      const { reason } = req.body ?? {};
      if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        return res.status(400).json({ error: '`reason` is required', code: 'INVALID_BODY' });
      }

      await flagAgentOnChain(address, reason.trim());
      agentsCache = null;
      logger.info({ address, reason }, 'Agent flagged on-chain by admin');
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err, address }, 'POST /admin/agents/:address/flag failed');
      return handleContractError(err, res, 'Failed to flag agent', 'FLAG_ERROR');
    }
  }
);

router.post(
  '/admin/agents/:address/deactivate',
  adminAuth,
  writeRateLimiter(),
  validateAgentAddressParam('address'),
  async (req, res) => {
    try {
      const { address } = req.params;
      await adminDeactivateAgentOnChain(address);
      agentsCache = null;
      logger.info({ address }, 'Agent admin-deactivated on-chain');
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err, address }, 'POST /admin/agents/:address/deactivate failed');
      return handleContractError(err, res, 'Failed to deactivate agent', 'DEACTIVATE_ERROR');
    }
  }
);

// Owner-only endpoint to update policy on-chain for an agent
router.post(
  '/agents/:address/policy',
  ownerAuth,
  writeRateLimiter(),
  validateAgentAddressParam('address'),
  async (req, res) => {
    try {
      const { address } = req.params;
      const { maxPerTxUsdc, maxPerDayUsdc, allowedCategories } = req.body ?? {};

      if (
        maxPerTxUsdc !== undefined &&
        (typeof maxPerTxUsdc !== 'number' || !Number.isFinite(maxPerTxUsdc) || maxPerTxUsdc < 0)
      ) {
        return res.status(400).json({ error: '`maxPerTxUsdc` must be a non-negative number', code: 'INVALID_BODY' });
      }
      if (
        maxPerDayUsdc !== undefined &&
        (typeof maxPerDayUsdc !== 'number' || !Number.isFinite(maxPerDayUsdc) || maxPerDayUsdc < 0)
      ) {
        return res.status(400).json({ error: '`maxPerDayUsdc` must be a non-negative number', code: 'INVALID_BODY' });
      }

      const policy = {
        maxPerTxUsdc: maxPerTxUsdc ?? undefined,
        maxPerDayUsdc: maxPerDayUsdc ?? undefined,
        allowedCategories: Array.isArray(allowedCategories) ? allowedCategories : undefined,
      };

      await updatePolicyOnChain(address, policy);
      agentsCache = null;
      logger.info({ address, policy }, 'Agent policy updated on-chain by owner');
      return res.json({ success: true });
    } catch (err) {
      logger.error({ err, address }, 'POST /agents/:address/policy failed');
      return handleContractError(err, res, 'Failed to update policy', 'POLICY_UPDATE_ERROR');
    }
  }
);

// Build unsigned agent transaction (provider/provider wallet signs)
router.post('/agents/:address/unsigned-tx', writeRateLimiter(), validateAgentAddressParam('address'), async (req, res) => {
  try {
    const { address } = req.params;
    const { action, params } = req.body ?? {};
    if (!action || typeof action !== 'string') {
      return res.status(400).json({ error: '`action` is required', code: 'INVALID_BODY' });
    }

    const prepared = await buildUnsignedAgentTx(action, address, params ?? {});
    logger.info({ address, action }, 'Built unsigned agent tx');
    return res.json(prepared);
  } catch (err) {
    logger.error({ err }, 'POST /agents/:address/unsigned-tx failed');
    return handleContractError(err, res, 'Failed to build unsigned tx', 'BUILD_TX_ERROR');
  }
});

// Submit signed agent transaction (wallet-signed)
router.post('/agents/submit-signed-tx', writeRateLimiter(), async (req, res) => {
  try {
    const { signedXdr, submitToken } = req.body ?? {};
    if (!signedXdr || typeof signedXdr !== 'string') {
      return res.status(400).json({ error: '`signedXdr` is required', code: 'INVALID_BODY' });
    }
    if (!submitToken || typeof submitToken !== 'string') {
      return res.status(400).json({ error: '`submitToken` is required', code: 'INVALID_BODY' });
    }

    // validatePreparedAgentSubmission is intentionally handled inside submitSignedAgentTx
    const result = await submitSignedAgentTx(signedXdr, submitToken);
    logger.info({ hash: result.hash }, 'Submitted signed agent tx');
    return res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, 'POST /agents/submit-signed-tx failed');
    return handleContractError(err, res, 'Failed to submit signed tx', 'SUBMIT_TX_ERROR');
  }
});

// GET /api/agents/:address
router.get('/agents/:address', requireAgentsContract, validateAgentAddressParam('address'), async (req, res) => {
  try {
    const { address } = req.params;
    const agent = await getAgent(address);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });
    }
    return res.json(agent);
  } catch (err) {
    logger.error({ err, address: req.params.address }, 'GET /api/agents/:address failed');
    return handleContractError(err, res, 'Failed to fetch agent', 'FETCH_ERROR');
  }
});

// GET /api/agents/:address/policy
router.get('/agents/:address/policy', requireAgentsContract, validateAgentAddressParam('address'), async (req, res) => {
  try {
    const { address } = req.params;
    const policy = await getAgentPolicy(address);
    if (!policy) {
      return res.status(404).json({ error: 'Policy not found', code: 'NOT_FOUND' });
    }
    return res.json(policy);
  } catch (err) {
    logger.error({ err, address: req.params.address }, 'GET /api/agents/:address/policy failed');
    return handleContractError(err, res, 'Failed to fetch policy', 'FETCH_ERROR');
  }
});

// GET /api/agents/:address/score
router.get('/agents/:address/score', requireAgentsContract, validateAgentAddressParam('address'), async (req, res) => {
  try {
    const { address } = req.params;
    const score = await getAgentScore(address);
    if (score == null) {
      return res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });
    }
    return res.json({ score });
  } catch (err) {
    logger.error({ err, address: req.params.address }, 'GET /api/agents/:address/score failed');
    return handleContractError(err, res, 'Failed to fetch score', 'FETCH_ERROR');
  }
});

// GET /api/agents/count
router.get('/agents/count', requireAgentsContract, async (req, res) => {
  try {
    const count = await getAgentCount();
    return res.json({ count });
  } catch (err) {
    logger.error({ err }, 'GET /api/agents/count failed');
    return handleContractError(err, res, 'Failed to fetch agent count', 'FETCH_ERROR');
  }
});

export default router;
