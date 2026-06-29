import 'dotenv/config';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pino from 'pino';
import pkg from '@stellar/stellar-sdk';
const { Keypair } = pkg;
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';

// ── Config ────────────────────────────────────────────────────────────────────

const required = ['AGENT_STELLAR_SECRET', 'STELLAR_RPC_URL', 'LODESTAR_API_URL'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

const AGENT_SECRET         = process.env.AGENT_STELLAR_SECRET;
const RPC_URL              = process.env.STELLAR_RPC_URL;
const LODESTAR_API_URL     = process.env.LODESTAR_API_URL;
const LODESTAR_HMAC_SECRET = process.env.LODESTAR_HMAC_SECRET ?? '';
const AGENT_NAME           = process.env.AGENT_NAME ?? 'Lodestar Agent';
const AGENT_DESC           = process.env.AGENT_DESC ?? 'AI agent powered by Lodestar';
const MAX_PER_TX           = process.env.MAX_PER_TX_USDC ?? '0.01';
const MAX_PER_DAY          = process.env.MAX_PER_DAY_USDC ?? '0.10';
const ALLOWED_CATS         = process.env.ALLOWED_CATEGORIES
  ? process.env.ALLOWED_CATEGORIES.split(',')
  : ['weather', 'search'];

const agentKeypair = Keypair.fromSecret(AGENT_SECRET);
const AGENT_ADDRESS = agentKeypair.publicKey();

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// ── Canonical event names ─────────────────────────────────────────────────────

export const EVENT = {
  AGENT_START:         'agent_start',
  AGENT_REGISTERED:    'agent_registered',
  TASK_START:          'task_start',
  SERVICE_SELECTED:    'service_selected',
  SPEND_CHECK_PASSED:  'spend_check_passed',
  SPEND_CHECK_BLOCKED: 'spend_check_blocked',
  PAYMENT_SUCCESS:     'payment_success',
  PAYMENT_FAILED:      'payment_failed',
  SCORE_UPDATED:       'score_updated',
  AGENT_COMPLETE:      'agent_complete',
};

// ── Credit scoring helpers ────────────────────────────────────────────────────

let currentScore = null;

export async function ensureRegistered() {
  try {
    const res = await fetch(`${LODESTAR_API_URL}/api/agents/${AGENT_ADDRESS}`);
    if (res.status === 503) {
      logger.info(
        { event: EVENT.AGENT_REGISTERED, agentAddress: AGENT_ADDRESS, scoringEnabled: false },
        'Agents contract not deployed — scoring disabled'
      );
      return false;
    }
    if (res.ok) {
      const data = await res.json();
      const agent = data.agent ?? data;
      currentScore = agent.score;
      const policy = data.policy;
      const dailyLimitUsdc = policy
        ? (Number(BigInt(policy.max_per_day_stroops)) / 10_000_000).toFixed(2)
        : null;
      logger.info(
        { event: EVENT.AGENT_REGISTERED, agentAddress: AGENT_ADDRESS, score: agent.score, dailyLimitUsdc, scoringEnabled: true },
        'Already registered'
      );
      return true;
    }
    if (res.status === 404) {
      logger.info(
        { event: EVENT.AGENT_REGISTERED, agentAddress: AGENT_ADDRESS },
        'Not registered — registering now…'
      );
      const regRes = await fetch(`${LODESTAR_API_URL}/api/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentAddress: AGENT_ADDRESS,
          name: AGENT_NAME,
          description: AGENT_DESC,
          maxPerTxUsdc: MAX_PER_TX,
          maxPerDayUsdc: MAX_PER_DAY,
          allowedCategories: ALLOWED_CATS,
        }),
      });
      if (regRes.ok) {
        currentScore = 100;
        logger.info(
          { event: EVENT.AGENT_REGISTERED, agentAddress: AGENT_ADDRESS, score: 100, scoringEnabled: true },
          'Registered — starting score: 100'
        );
        return true;
      }
      const err = await regRes.json().catch(() => ({}));
      logger.warn(
        { event: EVENT.AGENT_REGISTERED, agentAddress: AGENT_ADDRESS, scoringEnabled: false, err },
        'Registration failed — scoring disabled'
      );
      return false;
    }
  } catch (err) {
    logger.warn(
      { event: EVENT.AGENT_REGISTERED, agentAddress: AGENT_ADDRESS, scoringEnabled: false, err },
      'Could not reach agents API — scoring disabled'
    );
  }
  return false;
}

async function checkSpend(amountUsdc, category) {
  try {
    const res = await fetch(
      `${LODESTAR_API_URL}/api/agents/${AGENT_ADDRESS}/can-spend` +
      `?amount=${encodeURIComponent(amountUsdc)}&category=${encodeURIComponent(category)}`
    );
    if (!res.ok) return { allowed: true, reason: 'OK' };
    return await res.json();
  } catch {
    return { allowed: true, reason: 'OK' };
  }
}

async function recordOutcome(amountUsdc, success, serviceId) {
  try {
    const body = JSON.stringify({ amountUsdc, success, serviceId });
    const headers = { 'Content-Type': 'application/json' };
    if (LODESTAR_HMAC_SECRET) {
      headers['X-Lodestar-Signature'] = crypto
        .createHmac('sha256', LODESTAR_HMAC_SECRET)
        .update(body)
        .digest('hex');
    }
    const res = await fetch(`${LODESTAR_API_URL}/api/agents/${AGENT_ADDRESS}/payment`, {
      method: 'POST',
      headers,
      body,
    });
    if (res.ok) {
      const data = await res.json();
      const scoreBefore = currentScore;
      currentScore = data.newScore;
      logger.info(
        { event: EVENT.SCORE_UPDATED, agentAddress: AGENT_ADDRESS, scoreBefore, scoreAfter: currentScore },
        'Score updated'
      );
    }
  } catch {
    // non-critical
  }
}

// ── x402 client ───────────────────────────────────────────────────────────────

const STROOPS_PER_USDC = 10_000_000;

function stroopsToUsdcStr(stroops) {
  return String(Number(stroops) / STROOPS_PER_USDC);
}

function usdcStrToStroops(usdcStr) {
  return BigInt(Math.round(parseFloat(usdcStr) * STROOPS_PER_USDC));
}

function buildHttpClient() {
  const signer = createEd25519Signer(AGENT_SECRET, 'stellar:testnet');
  const scheme = new ExactStellarScheme(signer, { url: RPC_URL });
  const x402 = new x402Client().register('stellar:*', scheme);
  const httpClient = new x402HTTPClient(x402);

  // Implement fetch manually — x402HTTPClient.fetch() was removed in this version
  httpClient.fetch = async (url, init = {}) => {
    const probe = await fetch(url, init);
    if (probe.status !== 402) return probe;

    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => probe.headers.get(name),
      probe.status === 402 ? await probe.json().catch(() => undefined) : undefined
    );

    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
    return fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), ...paymentHeaders },
    });
  };

  return httpClient;
}

const httpClient = buildHttpClient();

export function dispose() {
  logger.info('Shutting down Lodestar Agent');
}

// ── Registry helpers ──────────────────────────────────────────────────────────

async function fetchServices(category) {
  const res = await fetch(`${LODESTAR_API_URL}/api/services?category=${category}`);
  if (!res.ok) throw new Error(`Registry fetch failed: ${res.status}`);
  const body = await res.json();
  return body.services ?? [];
}

async function submitReputation(id, positive) {
  try {
    const res = await fetch(`${LODESTAR_API_URL}/api/reputation/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positive, agent: AGENT_ADDRESS }),
    });
    if (!res.ok) {
      logger.debug({ status: res.status }, 'Reputation vote not applied (best-effort)');
    }
  } catch {
    // Intentionally best-effort — a failed vote must not abort the agent run.
  }
}

// Weighted random selection: higher reputation = proportionally more likely to be chosen.
// Falls back to uniform random when all weights are zero.
function selectWeighted(services) {
  const weights = services.map(s => Math.max(0, s.reputation));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total === 0) {
    return services[Math.floor(Math.random() * services.length)];
  }
  let r = Math.random() * total;
  for (let i = 0; i < services.length; i++) {
    r -= weights[i];
    if (r <= 0) return services[i];
  }
  return services[services.length - 1];
}

// ── Agent task ────────────────────────────────────────────────────────────────

export async function runTask(category, buildUrl, scoringEnabled, httpClient) {
  const taskStart = Date.now();
  logger.info({ event: EVENT.TASK_START, category, agentAddress: AGENT_ADDRESS }, 'Task started');

  const services = await fetchServices(category);

  if (!services.length) {
    logger.error(
      { event: EVENT.TASK_START, category, servicesFound: 0 },
      'No services found for category'
    );
    return { success: false, priceUsdc: null };
  }

  const failed = new Set();

  while (failed.size < services.length) {
    const candidates = services.filter((s) => !failed.has(s.id));
    const selected = selectWeighted(candidates);

    // ── Spend check ────────────────────────────────────────────────────────
    if (scoringEnabled) {
      const spend = await checkSpend(selected.price_usdc, category);
      if (!spend.allowed) {
        logger.warn(
          { event: EVENT.SPEND_CHECK_BLOCKED, category, serviceId: selected.id, reason: spend.reason },
          'Spend check blocked this service'
        );
        failed.add(selected.id);
        continue;
      }
      logger.debug(
        { event: EVENT.SPEND_CHECK_PASSED, category, serviceId: selected.id },
        'Spend check passed'
      );
    }

    const endpointUrl = buildUrl(selected.endpoint);
    logger.debug(
      { event: EVENT.TASK_START, category, serviceId: selected.id, endpointUrl },
      'Sending x402 payment on Stellar'
    );

    try {
      const serviceRes = await httpClient.fetch(endpointUrl, {
        headers: { 'X-Caller-Address': AGENT_ADDRESS },
      });

      if (serviceRes.ok) {
        const body = serviceRes.status !== 204 ? await serviceRes.json().catch(() => ({})) : {};
        if (scoringEnabled) {
          await recordOutcome(selected.price_usdc, true, selected.id);
          await submitReputation(selected.id, true);
        }
        logger.info(
          { event: EVENT.SERVICE_SELECTED, category, serviceId: selected.id, status: serviceRes.status },
          'Service responded'
        );
        return { success: true, priceUsdc: selected.price_usdc };
      }

      // Payment failed — try next service
      failed.add(selected.id);
      if (scoringEnabled) {
        await recordOutcome(selected.price_usdc, false, selected.id);
        await submitReputation(selected.id, false);
      }
      logger.warn(
        { event: EVENT.PAYMENT_FAILED, category, serviceId: selected.id, status: serviceRes.status },
        'Service rejected — trying next'
      );
    } catch (err) {
      failed.add(selected.id);
      logger.warn(
        { event: EVENT.PAYMENT_FAILED, category, serviceId: selected.id, err },
        'Service failed — trying next'
      );
    }
  }

  const taskDurationMs = Date.now() - taskStart;
  logger.error(
    { event: EVENT.PAYMENT_FAILED, category, servicesAttempted: failed.size, taskDurationMs },
    'All candidate services exhausted'
  );
  return { success: false, priceUsdc: null };
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main() {
  const runStart = Date.now();
  logger.info(
    { event: EVENT.AGENT_START, agentAddress: AGENT_ADDRESS, agentName: AGENT_NAME },
    'Lodestar Agent starting'
  );

  const scoringEnabled = await ensureRegistered();
  const scoreAfterRegistration = currentScore;

  const tasks = [
    { category: 'weather', buildUrl: (ep) => `${ep}?lat=40.7128&lon=-74.0060` },
    { category: 'search',  buildUrl: (ep) => `${ep}?q=Stellar+blockchain+AI+agents` },
  ];

  let successCount = 0;
  let failCount = 0;
  let totalUsdcSpent = 0;

  for (const { category, buildUrl } of tasks) {
    const result = await runTask(category, buildUrl, scoringEnabled, httpClient);
    if (result.success) {
      successCount++;
      totalUsdcSpent += parseFloat(result.priceUsdc ?? '0');
    } else {
      failCount++;
    }
  }

  const runDurationMs = Date.now() - runStart;
  const finalScore = currentScore;
  const scoreDelta =
    finalScore !== null && scoreAfterRegistration !== null
      ? finalScore - scoreAfterRegistration
      : null;

  logger.info(
    {
      event: EVENT.AGENT_COMPLETE,
      agentAddress: AGENT_ADDRESS,
      totalTasks: tasks.length,
      successCount,
      failCount,
      totalUsdcSpent: totalUsdcSpent.toFixed(6),
      finalScore,
      scoreDelta,
      runDurationMs,
    },
    'Agent run complete'
  );
}

// ── Entry point guard ─────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.on('SIGTERM', () => { dispose(); process.exit(0); });
  process.on('SIGINT',  () => { dispose(); process.exit(0); });
  main().catch((err) => {
    logger.error({ err }, 'Agent crashed');
    process.exit(1);
  });
}
