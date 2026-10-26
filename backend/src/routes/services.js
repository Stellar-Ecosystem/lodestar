import { Router } from 'express';
import { paymentMiddlewareFromConfig } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import config from '../config.js';
import logger from '../lib/logger.js';
import { recordPaymentOnChain, getAgent } from '../lib/contract.js';
import { ContractError } from '../lib/ContractError.js';
import {
  agentErrorFromHostError,
  registryErrorFromHostError,
} from '../lib/contractErrors.js';
import { usdcToStroops } from '../lib/stroops.js';
import { isValidStellarAddress } from '../middleware/addressValidator.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { validateWeatherRequest } from './servicesSchemas.js';

const router = Router();

/**
 * Documented HTTP status mapping for Soroban contract error variants that can
 * surface on `GET /demo/search` (#676).
 *
 * Variants not listed here (such as `NOT_INITIALIZED`, `ALREADY_INITIALIZED`,
 * `REGISTRY_NOT_INITIALIZED`, `REGISTRY_STORAGE_CORRUPTED`, `TRANSACTION_FAILED`,
 * `RETURN_VALUE_PARSE_FAILED`, or unknown variants) are treated as unmapped
 * internal contract failures: they log at `error` level with the variant name
 * and return `500 SEARCH_ERROR`.
 */
export const SEARCH_CONTRACT_ERROR_STATUS_MAP = Object.freeze({
  // 400 Bad Request — invalid arguments or simulation failure
  INVALID_AMOUNT: 400,
  ARITHMETIC_OVERFLOW: 400,
  INVALID_NAME: 400,
  INVALID_DESCRIPTION: 400,
  INVALID_ENDPOINT: 400,
  INVALID_CATEGORY: 400,
  SIMULATION_FAILED: 400,

  // 403 Forbidden — unauthorized caller or unregistered agent
  UNAUTHORIZED: 403,
  CALLER_NOT_REGISTERED_AGENT: 403,
  PROVIDER_MISMATCH: 403,

  // 404 Not Found — missing on-chain agent, policy, or service entry
  AGENT_NOT_FOUND: 404,
  POLICY_NOT_FOUND: 404,
  SERVICE_NOT_FOUND: 404,
  CATEGORY_INDEX_NOT_FOUND: 404,

  // 409 Conflict — duplicate registration or cooldown violation
  AGENT_ALREADY_REGISTERED: 409,
  DUPLICATE_SERVICE: 409,
  REPUTATION_VOTE_COOLDOWN: 409,

  // 503 Service Unavailable — rate-limited/throttled RPC or contract capacity limit
  RPC_THROTTLED: 503,
  AGENT_LIST_FULL: 503,
  AGENT_COUNT_OVERFLOW: 503,
  REGISTRY_PAUSED: 503,
  REGISTRY_COUNT_OVERFLOW: 503,
  AGENTS_CONTRACT_NOT_CONFIGURED: 503,

  // 504 Gateway Timeout — upstream RPC or confirmation timeout
  TRANSACTION_TIMEOUT: 504,
  UPSTREAM_TIMEOUT: 504,
});

function resolveSearchContractError(err) {
  if (err instanceof ContractError) {
    return err;
  }
  return agentErrorFromHostError(err) ?? registryErrorFromHostError(err);
}

// Validates and records a payment on-chain. All three guards (txHash presence,
// address format, and agent registration) must pass before touching the contract,
// so a forged or bypass-injected x-payment-address header is silently discarded.
const WEATHER_SERVICE_ID = 1;
const SEARCH_SERVICE_ID = 2;

// Validates and records a payment on-chain. All three guards (txHash presence,
// address format, and agent registration) must pass before touching the contract,
// so a forged or bypass-injected x-payment-address header is silently discarded.
async function creditPayment(agentAddress, txHash, serviceId, priceStroops, serviceLabel) {
  if (!txHash) {
    logger.warn(
      { agentAddress },
      `${serviceLabel} payment skipped: x-payment-transaction header absent (possible middleware bypass)`
    );
    return;
  }
  if (!isValidStellarAddress(agentAddress)) {
    logger.warn(
      { agentAddress },
      `${serviceLabel} payment skipped: x-payment-address fails Stellar address validation`
    );
    return;
  }
  const agent = await getAgent(agentAddress);
  if (!agent) {
    logger.warn(
      { agentAddress },
      `${serviceLabel} payment skipped: agent not registered on-chain`
    );
    return;
  }

  await recordPaymentOnChain(agentAddress, serviceId, priceStroops, true);

  logger.info({ agentAddress, txHash }, `${serviceLabel} payment credited to registered agent`);
}

// Activity feed lives in its own dependency-free module so the feed and
// pagination logic stay unit-testable in isolation.
export {
  recordActivity,
  getActivityFeed,
  parseActivityPagination,
  ACTIVITY_MAX_ENTRIES,
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
} from '../lib/activityFeed.js';

import {
  recordActivity,
  getActivityFeed,
  parseActivityPagination,
} from '../lib/activityFeed.js';

const facilitator = new HTTPFacilitatorClient({ url: config.x402.facilitatorUrl });
const stellarScheme = new ExactStellarScheme();

const paymentConfig = {
  'GET /demo/weather': {
    accepts: {
      scheme: 'exact',
      price: `$${config.x402.weatherPrice}`,
      network: 'stellar:testnet',
      payTo: config.x402.payTo,
    },
    description: 'Real-time weather data via Lodestar',
  },
  'GET /demo/search': {
    accepts: {
      scheme: 'exact',
      price: `$${config.x402.searchPrice}`,
      network: 'stellar:testnet',
      payTo: config.x402.payTo,
    },
    description: 'Web search results via Lodestar',
  },
};

// Ceiling for GET /demo/weather (#674). Every accepted call costs a
// facilitator verification plus an upstream Open-Meteo fetch, so the route is
// an amplifier: a cheap request to Lodestar becomes an expensive one against
// those upstreams. 30 requests per minute per IP is far above interactive
// use, yet still bounds the amplification — the number is chosen for this
// route's cost profile, not inherited from the generic write limit.
const weatherRateLimiter = createRateLimiter(
  config.rateLimit.weather.max,
  config.rateLimit.weather.windowMs,
);

// Mounted before the x402 middleware so a flood is rejected before it costs a
// facilitator verification or an upstream weather fetch.
router.use('/weather', weatherRateLimiter);

router.use(
  paymentMiddlewareFromConfig(paymentConfig, facilitator, [
    { network: 'stellar:testnet', server: stellarScheme },
  ])
);

router.get('/weather', async (req, res) => {
  try {
    // The schema is the route boundary (#675): a malformed request is a 400
    // with a catalogued code, and it never reaches the upstream provider or
    // the contract layer.
    const validation = validateWeatherRequest(req);
    if (!validation.ok) {
      logger.warn(
        { field: validation.field, code: validation.code },
        'Invalid request supplied to GET /demo/weather'
      );
      return res.status(validation.status).json({ error: validation.error, code: validation.code });
    }

    const lat = validation.data.query.lat ?? 40.7128;
    const lon = validation.data.query.lon ?? -74.006;

    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,wind_speed_10m,weather_code` +
      `&forecast_days=1`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Open-Meteo error: ${response.status}`);
    }

    const data = await response.json();
    const current = data.current;

    const result = {
      latitude: lat,
      longitude: lon,
      temperature_c: current.temperature_2m,
      wind_speed_kmh: current.wind_speed_10m,
      weather_code: current.weather_code,
      time: current.time,
    };

    const agentAddress = req.headers['x-payment-address'] ?? '';
    const txHash = req.headers['x-payment-transaction'] ?? '';

    recordActivity({
      timestamp: new Date().toISOString(),
      agent: agentAddress || 'unknown',
      service: 'Lodestar Weather Service',
      amount: config.x402.weatherPrice,
      txHash,
      ...(validation.data.query.demoRunId && { demoRunId: validation.data.query.demoRunId }),
    });

    if (agentAddress && config.contract.agentsId) {
      const priceStroops = usdcToStroops(config.x402.weatherPrice);
      creditPayment(agentAddress, txHash, WEATHER_SERVICE_ID, priceStroops, 'weather').catch((err) =>
        logger.warn({ err, agentAddress }, 'Failed to record weather payment for agent')
      );
    }

    logger.info({ lat, lon }, 'Weather request fulfilled');
    if (txHash) res.setHeader('x-payment-transaction', txHash);
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'GET /demo/weather failed');
    res.status(500).json({ error: 'Weather fetch failed', code: 'WEATHER_ERROR' });
  }
});

router.get('/search', async (req, res) => {
  try {
    const rawQuery = req.query.q;
    if (!rawQuery) {
      return res.status(400).json({ error: 'Query parameter `q` is required', code: 'MISSING_QUERY' });
    }

    const sanitizedQ = String(rawQuery)
      .trim()
      .replace(/[\u0000-\u001F\u007F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (sanitizedQ.length === 0 || sanitizedQ.length > 256) {
      logger.warn({ rawQuery }, 'Invalid search query supplied to GET /demo/search');
      return res.status(400).json({ error: 'Search query is invalid or too long', code: 'INVALID_QUERY' });
    }

    const response = await fetch(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': config.braveApiKey,
        },
        body: JSON.stringify({ q: sanitizedQ, num: 5 }),
      }
    );

    if (!response.ok) {
      throw new Error(`Serper Search error: ${response.status}`);
    }

    const data = await response.json();
    const results = (data.organic ?? []).slice(0, 5).map((r) => ({
      title: r.title,
      url: r.link,
      description: r.snippet,
    }));

    const searchAgentAddress = req.headers['x-payment-address'] ?? '';
    const searchTxHash = req.headers['x-payment-transaction'] ?? '';

    recordActivity({
      timestamp: new Date().toISOString(),
      agent: searchAgentAddress || 'unknown',
      service: 'Lodestar Search Service',
      amount: config.x402.searchPrice,
      txHash: searchTxHash,
      ...(req.query.demoRunId && { demoRunId: String(req.query.demoRunId) }),
    });

    if (searchAgentAddress && config.contract.agentsId) {
      const priceStroops = usdcToStroops(config.x402.searchPrice);
      await creditPayment(searchAgentAddress, searchTxHash, SEARCH_SERVICE_ID, priceStroops, 'search');
    }

    logger.info({ q: sanitizedQ }, 'Search request fulfilled');
    if (searchTxHash) res.setHeader('x-payment-transaction', searchTxHash);
    res.json({ query: sanitizedQ, results });
  } catch (err) {
    const contractErr = resolveSearchContractError(err);
    if (contractErr) {
      const variant = contractErr.variant ?? contractErr.code ?? contractErr.name;
      const mappedStatus = SEARCH_CONTRACT_ERROR_STATUS_MAP[variant];
      if (mappedStatus !== undefined) {
        logger.warn(
          { err: contractErr, variant, status: mappedStatus },
          `GET /demo/search failed with contract error (${variant})`
        );
        return res.status(mappedStatus).json({
          error: contractErr.message,
          code: contractErr.code,
        });
      }

      logger.error(
        { err: contractErr, variant },
        `GET /demo/search encountered unmapped contract error variant: ${variant}`
      );
      return res.status(500).json({ error: 'Search failed', code: 'SEARCH_ERROR' });
    }

    logger.error({ err }, 'GET /demo/search failed');
    res.status(500).json({ error: 'Search failed', code: 'SEARCH_ERROR' });
  }
});

router.get('/activity', (req, res) => {
  const { limit, offset, errors } = parseActivityPagination(req.query);
  if (errors.length > 0) {
    logger.warn({ query: req.query, errors }, 'Invalid activity pagination params');
    return res.status(400).json({ error: errors.join('; '), code: 'INVALID_PAGINATION' });
  }

  const feed = getActivityFeed();
  const total = feed.length;
  const items = feed.slice(offset, offset + limit);
  const hasMore = offset + items.length < total;

  logger.info({ limit, offset, total, returned: items.length }, 'Activity feed served');
  res.json({
    activity: items,
    pagination: { total, limit, offset, hasMore },
  });
});

export default router;
