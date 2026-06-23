import 'dotenv/config';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pino from 'pino';
import pkg from '@stellar/stellar-sdk';
const { Keypair } = pkg;
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import config from './backend/src/config.js';

// ── Config ────────────────────────────────────────────────────────────────────

const required = ['AGENT_STELLAR_SECRET', 'STELLAR_RPC_URL', 'LODESTAR_API_URL'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

const AGENT_SECRET         = process.env.AGENT_STELLAR_SECRET;
const RPC_URL              = process.env.STELLAR_RPC_URL;
const LODESTAR_API_URL     = process.env.LODESTAR_API_URL;
const LODESTAR_HMAC_SECRET = process.env.LODESTAR_HMAC_SECRET ?? '';


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

// ── x402 helpers ──────────────────────────────────────────────────────────────

function buildHttpClient() {
  const signer = createEd25519Signer(AGENT_SECRET, config.stellar.networkId);
  const scheme = new ExactStellarScheme(signer, { url: RPC_URL });
  const x402 = new x402Client().register('stellar:*', scheme);
  return new x402HTTPClient(x402);
}

const STROOPS_PER_USDC = 10_000_000;

function stroopsToUsdcStr(stroops) {
  return String(Number(stroops) / STROOPS_PER_USDC);
}

function usdcStrToStroops(usdcStr) {
  return BigInt(Math.round(parseFloat(usdcStr) * STROOPS_PER_USDC));
}

// ── Registry helpers ──────────────────────────────────────────────────────────

async function fetchServices(category) {
  const res = await fetch(`${LODESTAR_API_URL}/api/services?category=${category}`);
  if (!res.ok) throw new Error(`Registry fetch failed: ${res.status}`);
  const body = await res.json();
  return body.services ?? [];
}

async function submitReputation(id, positive) {
  // Identify this agent so the backend/contract can authorize the vote. The
  // backend only signs for registered demo agents it holds keys for; for other
  // agents this is best-effort and a 403/cooldown rejection is expected. fetch
  // only throws on network errors, so check response.ok before assuming success.
  try {
    const res = await fetch(`${LODESTAR_API_URL}/api/reputation/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positive, agent: AGENT_ADDRESS }),
    });
    if (!res.ok) {
      logger.debug({ status: res.status }, `${tag()} Reputation vote not applied (best-effort)`);
    }
  } catch {
    // Intentionally best-effort — a failed vote must not abort the agent run.
  }
}

// ── Agent task ────────────────────────────────────────────────────────────────

export async function runTask(category, buildUrl, scoringEnabled) {
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

  const best = [...services].sort((a, b) => b.reputation - a.reputation)[0];
  logger.info(
    {
      event: EVENT.SERVICE_SELECTED,
      category,
      serviceId: best.id,
      serviceName: best.name,
      priceUsdc: best.price_usdc,
      servicesFound: services.length,
    },
    'Service selected'
  );


  if (scoringEnabled) {
    const check = await checkSpend(demandedUsdc, category);
    if (!check.allowed) {
      logger.warn(
        {
          event: EVENT.SPEND_CHECK_BLOCKED,
          category,
          serviceId: best.id,
          serviceName: best.name,
          priceUsdc: best.price_usdc,
          reason: check.reason,
        },
        'Payment blocked by spending policy'
      );
      return { success: false, priceUsdc: null };
    }
    logger.info(
      { event: EVENT.SPEND_CHECK_PASSED, category, serviceId: best.id, serviceName: best.name, priceUsdc: best.price_usdc },
      'Spending policy check passed'
    );
  }



  // Step 4f: encode as header and retry
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
  let response;
  try {
    response = await fetch(endpointUrl, { headers: paymentHeaders });
  } catch (err) {

  }

  const txHash = response.headers.get('x-payment-transaction') ?? '(no hash)';
  const data = await response.json();

  await submitReputation(best.id, true);

  return { success: true, priceUsdc: best.price_usdc };
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
    const result = await runTask(category, buildUrl, scoringEnabled);
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
  main().catch((err) => {
    logger.error({ err }, 'Agent crashed');
    process.exit(1);
  });
}
