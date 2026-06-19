import { Router } from 'express';
import {
  listAgents,
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
  updatePolicyOnChain,
} from '../lib/contract.js';
import config from '../config.js';
import { ownerAuth } from '../middleware/ownerAuth.js';
import { hmacAuth } from '../middleware/hmacAuth.js';
import { paymentRateLimiter } from '../middleware/paymentRateLimiter.js';
import { validateAgentAddressParam, isValidStellarAddress } from '../middleware/addressValidator.js';
import logger from '../lib/logger.js';
import { handleContractError } from '../lib/ContractError.js';

const router = Router();

function requireAgentsContract(_req, res, next) {
  if (!config.contract.agentsId) {
    return res.status(503).json({
      error: 'Agents contract not yet deployed. Set AGENTS_CONTRACT_ID in .env',
      code: 'AGENTS_NOT_CONFIGURED',
    });
  }
  next();
}

// GET /api/agents — list all agents
router.get('/agents', requireAgentsContract, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 100);
    const agents = await listAgents(limit);
    res.json({ agents, count: agents.length });
  } catch (err) {
    logger.error({ err }, 'GET /api/agents failed');
    return handleContractError(err, res, 'Failed to fetch agents', 'FETCH_ERROR');
  }
});

// GET /api/agents/count
router.get('/agents/count', requireAgentsContract, async (_req, res) => {
  try {
    const count = await getAgentCount();
    res.json({ count });
  } catch (err) {
    logger.error({ err }, 'GET /api/agents/count failed');
    return handleContractError(err, res, 'Failed to fetch count', 'FETCH_ERROR');
  }
});

// GET /api/agents/stats
router.get('/agents/stats', requireAgentsContract, async (_req, res) => {
  try {
    const agents = await listAgents(100);
    const totalAgents = agents.length;

    if (totalAgents === 0) {
      return res.json({ totalAgents: 0, avgScore: 0, topAgent: null, totalVolume: '0' });
    }

    const avgScore = Math.round(agents.reduce((sum, a) => sum + a.score, 0) / totalAgents);
    const topAgent = agents.reduce((best, a) => (a.score > best.score ? a : best), agents[0]);

    const totalVolumeStroops = agents.reduce(
      (sum, a) => sum + BigInt(a.total_volume_stroops),
      0n
    );
    const totalVolumeUsdc = (Number(totalVolumeStroops) / 10_000_000).toFixed(2);

    res.json({ totalAgents, avgScore, topAgent, totalVolume: totalVolumeUsdc });
  } catch (err) {
    logger.error({ err }, 'GET /api/agents/stats failed');
    return handleContractError(err, res, 'Failed to fetch stats', 'FETCH_ERROR');
  }
});

// Param middleware for agent address routes
router.use('/agents/:address', validateAgentAddressParam);

// GET /api/agents/:address
router.get('/agents/:address', requireAgentsContract, async (req, res) => {
  try {
    const { address } = req.params;
    const [agent, policy] = await Promise.all([
      getAgent(address),
      getAgentPolicy(address),
    ]);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });
    }
    res.json({ agent, policy });
  } catch (err) {
    logger.error({ err, address: req.params.address }, 'GET /api/agents/:address failed');
    return handleContractError(err, res, 'Failed to fetch agent', 'FETCH_ERROR');
  }
});

// GET /api/agents/:address/policy
router.get('/agents/:address/policy', requireAgentsContract, async (req, res) => {
  try {
    const { address } = req.params;
    const policy = await getAgentPolicy(address);
    if (!policy) {
      return res.status(404).json({ error: 'Policy not found', code: 'NOT_FOUND' });
    }
    res.json(policy);
  } catch (err) {
    logger.error({ err, address: req.params.address }, 'GET /api/agents/:address/policy failed');
    return handleContractError(err, res, 'Failed to fetch policy', 'FETCH_ERROR');
  }
});

// GET /api/agents/:address/score
router.get('/agents/:address/score', requireAgentsContract, async (req, res) => {
  try {
    const score = await getAgentScore(req.params.address);
    res.json({ score });
  } catch (err) {
    logger.error({ err }, 'GET /api/agents/:address/score failed');
    return handleContractError(err, res, 'Failed to fetch score', 'FETCH_ERROR');
  }
});

// GET /api/agents/:address/eligible?min_score=500
router.get('/agents/:address/eligible', requireAgentsContract, async (req, res) => {
  try {
    const { address } = req.params;
    const minScore = parseInt(req.query.min_score ?? '0', 10);
    const [score, eligible] = await Promise.all([
      getAgentScore(address),
      isAgentEligible(address, minScore),
    ]);
    res.json({ eligible, score, required: minScore });
  } catch (err) {
    logger.error({ err, address: req.params.address }, 'GET /api/agents/:address/eligible failed');
    return handleContractError(err, res, 'Failed to check eligibility', 'FETCH_ERROR');
  }
});

// GET /api/agents/:address/can-spend?amount=0.001&category=weather
router.get('/agents/:address/can-spend', requireAgentsContract, async (req, res) => {
  try {
    const { address } = req.params;
    const amountUsdc = req.query.amount ?? '0';
    const category = req.query.category ?? '';
    const amountStroops = BigInt(Math.round(parseFloat(amountUsdc) * 10_000_000));

    const [allowed, policy, agent] = await Promise.all([
      checkSpendingAllowed(address, amountStroops),
      getAgentPolicy(address),
      getAgent(address),
    ]);

    if (!agent) {
      return res.json({ allowed: false, reason: 'Agent not registered' });
    }
    if (agent.flagged) {
      return res.json({ allowed: false, reason: 'Agent is flagged' });
    }
    if (!agent.active) {
      return res.json({ allowed: false, reason: 'Agent is deactivated' });
    }

    // Category check (backend-level since contract stores policy)
    if (policy && policy.allowed_categories.length > 0 && category) {
      if (!policy.allowed_categories.includes(category)) {
        return res.json({
          allowed: false,
          reason: `Category "${category}" not in agent's allowed list`,
        });
      }
    }

    if (!allowed) {
      const maxTx = policy ? BigInt(policy.max_per_tx_stroops) : 0n;
      const dailySpent = policy ? BigInt(policy.daily_spent_stroops) : 0n;
      const maxDay = policy ? BigInt(policy.max_per_day_stroops) : 0n;

      if (amountStroops > maxTx) {
        return res.json({
          allowed: false,
          reason: `Amount exceeds per-transaction limit of $${(Number(maxTx) / 10_000_000).toFixed(4)} USDC`,
        });
      }
      if (dailySpent + amountStroops > maxDay) {
        return res.json({
          allowed: false,
          reason: `Daily spending limit of $${(Number(maxDay) / 10_000_000).toFixed(4)} USDC reached`,
        });
      }
      return res.json({ allowed: false, reason: 'Spending policy violation' });
    }

    res.json({ allowed: true, reason: 'OK' });
  } catch (err) {
    logger.error({ err, address: req.params.address }, 'GET /api/agents/:address/can-spend failed');
    return handleContractError(err, res, 'Check failed', 'CHECK_ERROR');
  }
});

// POST /api/agents/register — Body: { agentAddress, name, description }
router.post('/agents/register', requireAgentsContract, async (req, res) => {
  try {
    const { agentAddress, name, description } = req.body;

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

    const count = await registerAgentOnChain(agentAddress, name.trim(), description.trim());
    logger.info({ agentAddress, name }, 'Agent registered on-chain');
    res.status(201).json({ success: true, agentCount: count, agentAddress });
  } catch (err) {
    logger.error({ err }, 'POST /api/agents/register failed');
    if (err.message?.includes('already registered')) {
      return res.status(409).json({ error: 'Agent already registered', code: 'ALREADY_EXISTS' });
    }
    return handleContractError(err, res, 'Registration failed', 'REGISTER_ERROR');
  }
});

// POST /api/agents/:address/payment — Body: { amountUsdc, success, serviceId }
router.post(
  '/agents/:address/payment',
  requireAgentsContract,
  hmacAuth,
  paymentRateLimiter(10, 60_000),
  async (req, res) => {
    try {
      const { address } = req.params;
      const { amountUsdc, success, serviceId } = req.body;

      if (typeof amountUsdc !== 'string' && typeof amountUsdc !== 'number') {
        return res.status(400).json({ error: '`amountUsdc` is required', code: 'INVALID_BODY' });
      }
      if (typeof success !== 'boolean') {
        return res.status(400).json({ error: '`success` must be boolean', code: 'INVALID_BODY' });
      }
      if (!serviceId || typeof serviceId !== 'number') {
        return res.status(400).json({ error: '`serviceId` is required', code: 'INVALID_BODY' });
      }

      const amountStroops = BigInt(Math.round(parseFloat(String(amountUsdc)) * 10_000_000));
      await recordPaymentOnChain(address, serviceId, amountStroops, success);
      const agent = await getAgent(address);
      const newScore = agent?.score ?? 0;
      logger.info({ address, serviceId, amountUsdc, success, newScore }, 'Payment recorded on-chain');
      res.json({ success: true, newScore });
    } catch (err) {
      logger.error({ err, address: req.params.address }, 'POST /api/agents/:address/payment failed');
      return handleContractError(err, res, 'Failed to record payment', 'RECORD_ERROR');
    }
  }
);

// GET /api/agents/:address/check?amount=1000000 (legacy stroops endpoint)
router.get('/agents/:address/check', requireAgentsContract, async (req, res) => {
  try {
    const { address } = req.params;
    const amount = BigInt(req.query.amount ?? '0');
    const allowed = await checkSpendingAllowed(address, amount);
    res.json({ allowed, agentAddress: address, amountStroops: amount.toString() });
  } catch (err) {
    logger.error({ err }, 'GET /api/agents/:address/check failed');
    return handleContractError(err, res, 'Check failed', 'CHECK_ERROR');
  }
});

// Admin routes for owner actions
router.post('/agents/:address/flag', requireAgentsContract, ownerAuth, async (req, res) => {
  try {
    const { address } = req.params;
    const { reason } = req.body;
    if (!reason || typeof reason !== 'string') {
      return res.status(400).json({ error: '`reason` is required', code: 'INVALID_BODY' });
    }
    await flagAgentOnChain(address, reason, req.callerAddress);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'POST /agents/:address/flag failed');
    return handleContractError(err, res, 'Flagging failed', 'FLAG_ERROR');
  }
});

router.post('/agents/:address/deactivate', requireAgentsContract, ownerAuth, async (req, res) => {
  try {
    const { address } = req.params;
    await deactivateAgentOnChain(address, req.callerAddress);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'POST /agents/:address/deactivate failed');
    return handleContractError(err, res, 'Deactivation failed', 'DEACTIVATE_ERROR');
  }
});

router.post('/agents/:address/policy', requireAgentsContract, ownerAuth, async (req, res) => {
  try {
    const { address } = req.params;
    const { maxPerTxStroops, maxPerDayStroops, allowedCategories, minScoreToEarn } = req.body;
    if (!maxPerTxStroops || !maxPerDayStroops || !Array.isArray(allowedCategories) || typeof minScoreToEarn !== 'number') {
      return res.status(400).json({ error: 'Invalid policy parameters', code: 'INVALID_BODY' });
    }
    await updatePolicyOnChain(address, maxPerTxStroops, maxPerDayStroops, allowedCategories, minScoreToEarn, req.callerAddress);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'POST /agents/:address/policy failed');
    return handleContractError(err, res, 'Policy update failed', 'POLICY_ERROR');
  }
});

export default router;
