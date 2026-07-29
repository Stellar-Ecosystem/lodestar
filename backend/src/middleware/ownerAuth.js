import { getAgent } from '../lib/contract.js';
import logger from '../lib/logger.js';

/**
 * Middleware to ensure the request is made by the owner of the agent.
 * Expects the caller's Stellar address in the 'x-caller-address' header.
 * Sets `req.callerAddress` on success.
 */
export async function ownerAuth(req, res, next) {
  try {
    const callerAddress = req.headers['x-caller-address'];
    if (!callerAddress || typeof callerAddress !== 'string') {
      return res.status(401).json({ error: 'Caller address missing', code: 'AUTH_MISSING' });
    }
    const { address } = req.params;
    if (!address) {
      return res.status(400).json({ error: 'Agent address param missing', code: 'INVALID_PARAMS' });
    }
    const agent = await getAgent(address);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found', code: 'NOT_FOUND' });
    }
    if (agent.owner !== callerAddress) {
      return res
        .status(403)
        .json({ error: 'Caller is not the owner of this agent', code: 'FORBIDDEN' });
    }
    // Attach to request for downstream handlers
    req.callerAddress = callerAddress;
    next();
  } catch (err) {
    logger.error({ err }, 'ownerAuth middleware failed');
    res.status(500).json({ error: 'Internal auth error', code: 'AUTH_ERROR' });
  }
}
