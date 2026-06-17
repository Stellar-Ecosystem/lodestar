import logger from '../lib/logger.js';

const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

export function isValidStellarAddress(address) {
  return typeof address === 'string' && STELLAR_ADDRESS_REGEX.test(address);
}

export function validateAgentAddressParam(req, res, next) {
  const { address } = req.params;
  if (!isValidStellarAddress(address)) {
    logger.warn({ address }, 'Invalid agent address parameter');
    return res.status(400).json({
      error: 'Invalid Stellar address format',
      code: 'INVALID_ADDRESS',
    });
  }
  next();
}
