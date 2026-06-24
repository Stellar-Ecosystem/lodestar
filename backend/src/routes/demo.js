import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import config from '../config.js';
import logger from '../lib/logger.js';
import { getService } from '../lib/contract.js';
import { waitForActivityTxHash } from '../lib/waitForActivityTxHash.js';
import { recordActivity, getActivityFeed } from './services.js';

const router = Router();

// Strict allowlist of demo paths per category.
// Each entry maps category → { pathname, allowed query params }
const DEMO_ALLOWLIST = {
  weather: { pathname: '/demo/weather', allowedParams: new Set(['lat', 'lon']) },
  search:  { pathname: '/demo/search',  allowedParams: new Set(['q']) },
};

/**
 * Validate and rewrite a registry endpoint for use as a demo loopback URL.
 * Rejects any path that is not in the per-category allowlist (prevents SSRF).
 * Returns the sanitized URL, or null if validation fails.
 */
function validateDemoEndpoint(registryEndpoint, category, port) {
  const rule = DEMO_ALLOWLIST[category];
  if (!rule) return null;

  let parsed;
  try {
    // Force a known origin so the URL constructor resolves relative paths
    parsed = new URL(registryEndpoint);
  } catch {
    return null;
  }

  // Rewrite origin to loopback — normalises path traversal (/../ etc.) in the process
  const rewritten = new URL(`http://127.0.0.1:${port}${parsed.pathname}`);

  if (rewritten.pathname !== rule.pathname) {
    return null;
  }

  return rewritten.toString();
}

function buildHttpClient() {
  const signer = createEd25519Signer(config.server.secret, 'stellar:testnet');
  const scheme = new ExactStellarScheme(signer, { url: config.stellar.rpcUrl });
  const x402 = new x402Client().register('stellar:*', scheme);
  const httpClient = new x402HTTPClient(x402);

  // Returns { response, txHash }
  httpClient.fetchWithTx = async (url, init = {}) => {
    const probe = await fetch(url, init);
    if (probe.status !== 402) return { response: probe, txHash: '' };

    const body = await probe.json().catch(() => undefined);
    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => probe.headers.get(name),
      body
    );

    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

    const paid = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), ...paymentHeaders },
    });

    return { response: paid, txHash: '' };
  };

  return httpClient;
}

router.post('/demo-run', async (req, res) => {
  try {
    const { serviceId, category } = req.body;

    if (!serviceId || !category) {
      return res.status(400).json({ error: 'serviceId and category are required', code: 'INVALID_BODY' });
    }

    const service = await getService(Number(serviceId));
    if (!service) {
      return res.status(404).json({ error: 'Service not found', code: 'NOT_FOUND' });
    }

    // Validate the registry endpoint against the per-category allowlist before loopback rewrite
    const safeBase = validateDemoEndpoint(service.endpoint, category, config.port);
    if (!safeBase) {
      logger.warn(
        { originalEndpoint: service.endpoint, category, serviceId, reason: 'blocked_ssrf_attempt' },
        'Demo endpoint failed path validation — request blocked'
      );
      return res.status(400).json({ error: 'Endpoint not allowed for demo', code: 'ENDPOINT_NOT_ALLOWED' });
    }

    // Append only the known, safe query params for this category (no query string from registry)
    const endpointUrlObj = new URL(safeBase);
    if (category === 'weather') {
      endpointUrlObj.searchParams.set('lat', '40.7128');
      endpointUrlObj.searchParams.set('lon', '-74.0060');
    } else if (category === 'search') {
      endpointUrlObj.searchParams.set('q', 'Stellar+blockchain+AI+agents');
    }
    let endpointUrl = endpointUrlObj.toString();

    const demoRunId = randomUUID();
    const endpoint = new URL(endpointUrl);
    endpoint.searchParams.set('demoRunId', demoRunId);
    endpointUrl = endpoint.toString();

    const httpClient = buildHttpClient();
    const activityCountBefore = getActivityFeed().length;

    const { response } = await httpClient.fetchWithTx(endpointUrl);

    if (!response.ok) {
      throw new Error(`Service responded with ${response.status}`);
    }

    const data = await response.json();

    const txHash = await waitForActivityTxHash(
      getActivityFeed,
      activityCountBefore,
      config.demoRun,
      (entry) => entry.demoRunId === demoRunId,
    );
    if (!txHash) {
      logger.warn(
        { serviceId, category, maxWaitMs: config.demoRun.pollMaxWaitMs },
        'Activity txHash not found before poll timeout',
      );
    }

    recordActivity({
      timestamp: new Date().toISOString(),
      agent: config.server.address,
      service: service.name,
      amount: service.price_usdc,
      txHash,
    });

    logger.info({ serviceId, category, txHash }, 'Demo run complete');
    res.json({ data, txHash });
  } catch (err) {
    logger.error({ err }, 'POST /api/demo-run failed');
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Demo run failed',
      code: 'DEMO_ERROR',
    });
  }
});

export default router;
