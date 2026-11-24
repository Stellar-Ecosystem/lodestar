import 'dotenv/config';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import pino from 'pino';
import pkg from '@stellar/stellar-sdk';
const { Keypair } = pkg;
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';
import { buildRunSummary, writeRunSummary } from './runSummary.js';
import { stroopsToUsdcDisplay } from '../packages/stroops/index.js';



function loadSecret() {
  const envSecret = process.env.AGENT_STELLAR_SECRET;
  const filePath  = process.env.AGENT_STELLAR_SECRET_FILE;

  if (envSecret && filePath) {
    throw new Error('Set only one of AGENT_STELLAR_SECRET or AGENT_STELLAR_SECRET_FILE, not both');
  }

  if (filePath) {
    let secret;
    try {
      secret = fs.readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      throw new Error(`Failed to read AGENT_STELLAR_SECRET_FILE: ${err.message}`);
    }

    if (process.platform !== 'win32') {
      const mode = fs.statSync(filePath).mode;
      const groupRead = !!(mode & 0o040);
      const otherRead = !!(mode & 0o004);
      if (groupRead || otherRead) {
        throw new Error(
          `AGENT_STELLAR_SECRET_FILE at ${filePath} is group/world readable. ` +
          `Run: chmod 600 ${filePath}`
        );
      }
    }

    return secret;
  }

  if (envSecret) {
    return envSecret;
  }

  throw new Error('Missing AGENT_STELLAR_SECRET or AGENT_STELLAR_SECRET_FILE');
}

let AGENT_SECRET = loadSecret();

const required = ['STELLAR_RPC_URL', 'LODESTAR_API_URL'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

const RPC_URL              = process.env.STELLAR_RPC_URL;
const LODESTAR_API_URL     = process.env.LODESTAR_API_URL;
const LODESTAR_HMAC_SECRET = process.env.LODESTAR_HMAC_SECRET ?? '';

const AGENT_NAME           = process.env.AGENT_NAME           ?? 'LodestarAgent';
const AGENT_DESC           = process.env.AGENT_DESC           ?? '';
const MAX_PER_TX           = process.env.AGENT_MAX_PER_TX     ?? '0.001';
const MAX_PER_DAY          = process.env.AGENT_MAX_PER_DAY    ?? '1.00';
const ALLOWED_CATS         = process.env.AGENT_ALLOWED_CATEGORIES
  ? process.env.AGENT_ALLOWED_CATEGORIES.split(',').map(s => s.trim()).filter(Boolean)
  : ['weather', 'search'];

let agentKeypair;
try {
  agentKeypair = Keypair.fromSecret(AGENT_SECRET);
} catch {
  throw new Error(`Invalid AGENT_STELLAR_SECRET: unable to parse secret key`);
}
const AGENT_ADDRESS = agentKeypair.publicKey();


AGENT_SECRET = undefined;

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const FETCH_TIMEOUT_MS = Number.isFinite(Number(process.env.AGENT_FETCH_TIMEOUT_MS))
  ? Math.max(1, Number(process.env.AGENT_FETCH_TIMEOUT_MS))
  : 5000;

async function fetchWithTimeout(resource, init = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(resource, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

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
  PAYMENT_UNKNOWN:     'payment_unknown',
  ENDPOINT_INACTIVE:   'endpoint_inactive',
  TASK_EXHAUSTED:      'task_exhausted',
  SCORE_UPDATED:       'score_updated',
  AGENT_COMPLETE:      'agent_complete',
};

// ── Credit scoring helpers ────────────────────────────────────────────────────

let currentScore = null;

export async function ensureRegistered() {
  try {
    const res = await fetchWithTimeout(`${LODESTAR_API_URL}/api/agents/${AGENT_ADDRESS}`);
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
        ? stroopsToUsdcDisplay(policy.max_per_day_stroops)
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
      const regRes = await fetchWithTimeout(`${LODESTAR_API_URL}/api/agents/register`, {
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
    const res = await fetchWithTimeout(
      `${LODESTAR_API_URL}/api/agents/${AGENT_ADDRESS}/can-spend` +
      `?amount=${encodeURIComponent(amountUsdc)}&category=${encodeURIComponent(category)}`
    );
    if (!res.ok) return { allowed: true, reason: 'OK' };
    return await res.json();
  } catch {
    return { allowed: true, reason: 'OK' };
  }
}

async function recordOutcome(amountUsdc, success, serviceId, idempotencyKey) {
  try {
    const body = JSON.stringify({ amountUsdc, success, serviceId });
    const headers = { 'Content-Type': 'application/json', 'X-Idempotency-Key': idempotencyKey };
    if (LODESTAR_HMAC_SECRET) {
      headers['X-Lodestar-Signature'] = crypto
        .createHmac('sha256', LODESTAR_HMAC_SECRET)
        .update(body)
        .digest('hex');
    }
    const res = await fetchWithTimeout(`${LODESTAR_API_URL}/api/agents/${AGENT_ADDRESS}/payment`, {
      method: 'POST',
      headers,
      body,
    });
    if (res.ok) {
      const data = await res.json();
      const scoreBefore = currentScore;
      currentScore = data.newScore;
      logger.info(
        { event: EVENT.SCORE_UPDATED, agentAddress: AGENT_ADDRESS, scoreBefore, scoreAfter: currentScore, idempotencyKey },
        'Score updated'
      );
    }
  } catch {
    // non-critical
  }
}

/**
 * Generate a stable idempotency key for a payment outcome.
 *
 * The key is scoped to the agent address, service, and the run-start timestamp
 * so that:
 *   - Two different runs never share a key (the timestamp component differs).
 *   - Retrying recordOutcome within the same run always reuses the same key,
 *     preventing a second on-chain record for an already-settled request.
 *
 * @param {number} serviceId
 * @param {number} runStartMs - value of `taskStart` captured when the attempt began
 * @returns {string}
 */
export function buildPaymentIdempotencyKey(serviceId, runStartMs) {
  return `${AGENT_ADDRESS}-svc${serviceId}-t${runStartMs}`;
}

// ── x402 client ───────────────────────────────────────────────────────────────

const httpClient = buildHttpClient();

export function dispose() {
  logger.info('Shutting down Lodestar Agent');
}

// USDC <-> stroop conversion comes from the shared package so the agent and
// the backend cannot disagree on rounding (#853). The previous local copies
// used floating-point math and were removed.

function buildHttpClient() {
  // Re-read the secret for the x402 signer since the module-level reference
  // has already been zeroed. loadSecret() re-reads from the env var or file.
  const secretForSigner = loadSecret();
  const signer = createEd25519Signer(secretForSigner, 'stellar:testnet');
  const scheme = new ExactStellarScheme(signer, { url: RPC_URL });
  const x402 = new x402Client().register('stellar:*', scheme);
  const httpClient = new x402HTTPClient(x402);

  // Implement fetch manually — x402HTTPClient.fetch() was removed in this version
  httpClient.fetch = async (url, init = {}) => {
    const probe = await fetchWithTimeout(url, init);
    if (probe.status !== 402) return probe;

    const paymentRequired = httpClient.getPaymentRequiredResponse(
      (name) => probe.headers.get(name),
      probe.status === 402 ? await probe.json().catch(() => undefined) : undefined
    );

    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
    const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
    return fetchWithTimeout(url, {
      ...init,
      headers: { ...(init.headers ?? {}), ...paymentHeaders },
    });
  };

  return httpClient;
}

// ── Registry helpers ──────────────────────────────────────────────────────────

async function fetchServices(category) {
  const res = await fetchWithTimeout(`${LODESTAR_API_URL}/api/services?category=${category}`);
  if (!res.ok) throw new Error(`Registry fetch failed: ${res.status}`);
  const body = await res.json();
  return body.services ?? [];
}

async function submitReputation(id, positive) {
  try {
    const res = await fetchWithTimeout(`${LODESTAR_API_URL}/api/reputation/${id}`, {
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

export async function runTask(category, buildUrl, scoringEnabled, client = httpClient) {
  const minReputation = parseInt(process.env.AGENT_MIN_SERVICE_REPUTATION ?? '0', 10);
  const maxRetries    = parseInt(process.env.AGENT_MAX_SERVICE_RETRIES    ?? '3', 10);

  const taskStart = Date.now();
  logger.info({ event: EVENT.TASK_START, category, agentAddress: AGENT_ADDRESS }, 'Task started');

  const services = await fetchServices(category);

  if (!services.length) {
    logger.error(
      { event: EVENT.TASK_START, category, servicesFound: 0 },
      'No services found for category'
    );
    return { success: false, priceUsdc: null, servicesDiscovered: 0, servicesEligible: 0, attempts: 0, failureReason: 'no_services_found' };
  }

  const eligible = services.filter(s => s.reputation >= minReputation);
  if (!eligible.length) {
    logger.error(
      { event: EVENT.TASK_START, category, servicesFound: services.length, minReputation },
      'No services meet minimum reputation threshold'
    );
    return {
      success: false,
      priceUsdc: null,
      servicesDiscovered: services.length,
      servicesEligible: 0,
      attempts: 0,
      failureReason: 'no_services_meet_min_reputation',
    };
  }

  // Top-N candidates by reputation; weighted random selection reduces single-point manipulation.
  const candidates = [...eligible].sort((a, b) => b.reputation - a.reputation).slice(0, maxRetries);
  const failed = new Set();

  // Track services whose payment was signed and submitted but whose on-chain
  // outcome is unknown (probe returned 402, payment headers were sent, but the
  // second fetch failed before a response arrived).  Such services must NOT be
  // retried within this run — a second payment header would constitute a second
  // on-chain transaction for a request that may already be settled.
  const paymentUnknown = new Set();

  for (let attempt = 1; attempt <= candidates.length; attempt++) {
    const available = candidates.filter(s => !failed.has(s.id) && !paymentUnknown.has(s.id));
    if (!available.length) break;

    const selected = selectWeighted(available);

    logger.info(
      {
        event: EVENT.SERVICE_SELECTED,
        category,
        serviceId: selected.id,
        serviceName: selected.name,
        priceUsdc: selected.price_usdc,
        servicesFound: services.length,
        attempt,
      },
      'Service selected'
    );

    if (scoringEnabled) {
      const check = await checkSpend(selected.price_usdc, category);
      if (!check.allowed) {
        logger.warn(
          {
            event: EVENT.SPEND_CHECK_BLOCKED,
            category,
            serviceId: selected.id,
            serviceName: selected.name,
            priceUsdc: selected.price_usdc,
            reason: check.reason,
          },
          'Payment blocked by spending policy'
        );
        failed.add(selected.id);
        continue;
      }
      logger.info(
        { event: EVENT.SPEND_CHECK_PASSED, category, serviceId: selected.id, serviceName: selected.name, priceUsdc: selected.price_usdc },
        'Spending policy check passed'
      );
    }

    const endpointUrl = buildUrl(selected.endpoint);
    logger.debug(
      { event: EVENT.TASK_START, category, serviceId: selected.id, endpointUrl },
      'Sending x402 payment on Stellar'
    );

    // A stable key scoped to this agent + service + run start.  Using the same
    // key on a retry sends a replay request to the backend instead of a second
    // on-chain record (#LDS-2026-182).
    const idempotencyKey = buildPaymentIdempotencyKey(selected.id, taskStart);

    // ── x402 probe ────────────────────────────────────────────────────────────
    // Phase 1: probe the endpoint without a payment header.
    // If the endpoint is inactive it will return something other than 402
    // (typically 503 / connection refused / timeout), so no payment is ever
    // signed.  Only a genuine 402 response causes the payment to be signed and
    // submitted (Phase 2).  We track that transition explicitly so that a
    // network failure between Phase 1 and the confirmation of Phase 2 is
    // treated as an unknown state rather than a safe no-op.
    const paymentPayload = { url: endpointUrl, method: 'GET' };
    const paymentHeaders = client.encodePaymentSignatureHeader(paymentPayload);

    // Phase 1: probe without payment
    let probeResponse;
    try {
      probeResponse = await fetchWithTimeout(endpointUrl, { keepalive: true });
    } catch (err) {
      // Endpoint unreachable — no payment was signed.
      logger.warn(
        {
          event: EVENT.ENDPOINT_INACTIVE,
          category,
          serviceId: selected.id,
          serviceName: selected.name,
          priceUsdc: selected.price_usdc,
          err,
          taskDurationMs: Date.now() - taskStart,
        },
        'Endpoint inactive — no payment signed, skipping to next candidate'
      );
      failed.add(selected.id);
      continue;
    }

    if (probeResponse.status !== 402) {
      // Endpoint returned a non-402 status — it may be down, misconfigured, or
      // temporarily unavailable.  No payment has been signed yet.
      logger.warn(
        {
          event: EVENT.ENDPOINT_INACTIVE,
          category,
          serviceId: selected.id,
          serviceName: selected.name,
          priceUsdc: selected.price_usdc,
          httpStatus: probeResponse.status,
          taskDurationMs: Date.now() - taskStart,
        },
        'Endpoint inactive — unexpected status (not 402), no payment signed'
      );
      failed.add(selected.id);
      continue;
    }

    // Phase 2: payment is about to be signed and submitted.  From this point on,
    // any network failure puts this service into the UNKNOWN state: the
    // transaction may or may not have reached the network.
    let response;
    try {
      response = await fetchWithTimeout(endpointUrl, { headers: paymentHeaders, keepalive: true });
    } catch (err) {
      // The payment header was sent but we never received a confirmation.
      // Mark this service as unknown so it is excluded from further retries
      // within this run — a retry could sign and submit a second payment.
      paymentUnknown.add(selected.id);
      logger.error(
        {
          event: EVENT.PAYMENT_UNKNOWN,
          category,
          serviceId: selected.id,
          serviceName: selected.name,
          priceUsdc: selected.price_usdc,
          err,
          idempotencyKey,
          taskDurationMs: Date.now() - taskStart,
        },
        'Payment state unknown — signed payment sent but no response received; will not retry this service'
      );
      // Record the unresolved outcome so the run summary captures it.  The
      // idempotency key ensures the backend deduplicates if this call and a
      // future retry of the entire run both reach the backend.
      if (scoringEnabled) await recordOutcome(selected.price_usdc, false, selected.id, idempotencyKey);
      continue;
    }

    if (!response.ok) {
      logger.error(
        {
          event: EVENT.PAYMENT_FAILED,
          category,
          serviceId: selected.id,
          serviceName: selected.name,
          priceUsdc: selected.price_usdc,
          httpStatus: response.status,
          taskDurationMs: Date.now() - taskStart,
        },
        'Payment failed — endpoint error'
      );
      if (scoringEnabled) await recordOutcome(selected.price_usdc, false, selected.id, idempotencyKey);
      // Payment settled but service returned bad data — penalise service reputation.
      await submitReputation(selected.id, false);
      failed.add(selected.id);
      continue;
    }

    const txHash = response.headers.get('x-payment-transaction') ?? '(no hash)';
    const scoreBefore = currentScore;
    if (scoringEnabled) await recordOutcome(selected.price_usdc, true, selected.id, idempotencyKey);

    logger.info(
      {
        event: EVENT.PAYMENT_SUCCESS,
        category,
        serviceId: selected.id,
        serviceName: selected.name,
        priceUsdc: selected.price_usdc,
        txHash,
        scoreBefore,
        taskDurationMs: Date.now() - taskStart,
      },
      'Payment successful'
    );

    await submitReputation(selected.id, true);

    return {
      success: true,
      priceUsdc: selected.price_usdc,
      txHash,
      servicesDiscovered: services.length,
      servicesEligible: eligible.length,
      attempts: attempt,
      scoreAfter: currentScore,
      durationMs: Date.now() - taskStart,
      selection: {
        serviceId: selected.id,
        serviceName: selected.name,
        reputation: selected.reputation,
        priceUsdc: selected.price_usdc,
        // Why this service: top-N by reputation, then reputation-weighted random
        // pick among the candidates still untried.
        strategy: 'reputation_weighted_random',
        candidatesConsidered: candidates.length,
        minReputation,
      },
    };
  }

  const taskDurationMs = Date.now() - taskStart;
  const hasUnknown = paymentUnknown.size > 0;

  if (hasUnknown) {
    logger.error(
      {
        event: EVENT.TASK_EXHAUSTED,
        category,
        servicesAttempted: failed.size + paymentUnknown.size,
        servicesWithUnknownPayment: paymentUnknown.size,
        unknownServiceIds: [...paymentUnknown],
        taskDurationMs,
      },
      'Task ended with unknown payment state — check on-chain status before retrying'
    );
    return {
      success: false,
      priceUsdc: null,
      servicesDiscovered: services.length,
      servicesEligible: eligible.length,
      attempts: failed.size + paymentUnknown.size,
      durationMs: taskDurationMs,
      failureReason: 'payment_state_unknown',
      _unresolved: { serviceIds: [...paymentUnknown] },
    };
  }

  logger.error(
    { event: EVENT.TASK_EXHAUSTED, category, servicesAttempted: failed.size, taskDurationMs },
    'All candidate services exhausted'
  );
  return {
    success: false,
    priceUsdc: null,
    servicesDiscovered: services.length,
    servicesEligible: eligible.length,
    attempts: failed.size,
    durationMs: taskDurationMs,
    failureReason: 'all_candidates_exhausted',
  };
}

// ── Shutdown state ─────────────────────────────────────────────────────────────

let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.AGENT_SHUTDOWN_TIMEOUT_MS ?? '30000', 10);
let shutdownTimer = null;

export async function initiateShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(
    { event: 'shutdown_initiated', signal },
    `Graceful shutdown initiated (${signal}) — no new work will be started`
  );

  shutdownTimer = setTimeout(() => {
    const pendingCount = getPendingTransactionCount ? getPendingTransactionCount() : 0;
    logger.warn(
      { event: 'shutdown_timeout', pendingTransactions: pendingCount },
      `Shutdown timeout reached after ${SHUTDOWN_TIMEOUT_MS}ms — exiting`
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  shutdownTimer.unref();
}

async function completeShutdown(success, unresolved) {
  if (shutdownTimer) clearTimeout(shutdownTimer);

  const finalScore = currentScore;
  logger.info(
    {
      event: 'shutdown_complete',
      success,
      unresolvedPayments: unresolved,
      finalScore,
    },
    'Agent shutdown complete'
  );

  dispose();
  process.exit(success ? 0 : 1);
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
  const unresolvedPayments = [];
  const taskResults = [];

  for (const { category, buildUrl } of tasks) {
    if (shuttingDown) {
      logger.warn({ event: 'shutdown_skip_task', category }, 'Skipping task due to shutdown');
      failCount++;
      taskResults.push({ category, success: false, failureReason: 'skipped_due_to_shutdown' });
      continue;
    }

    const result = await runTask(category, buildUrl, scoringEnabled, httpClient);
    taskResults.push({ category, ...result });
    if (result.success) {
      successCount++;
      totalUsdcSpent += parseFloat(result.priceUsdc ?? '0');
    } else {
      failCount++;
      if (result._unresolved) {
        for (const serviceId of result._unresolved.serviceIds) {
          unresolvedPayments.push({ category, serviceId, priceUsdc: result.priceUsdc });
        }
      }
    }
  }

  const runDurationMs = Date.now() - runStart;
  const finalScore = currentScore;
  const scoreDelta =
    finalScore !== null && scoreAfterRegistration !== null
      ? finalScore - scoreAfterRegistration
      : null;

  const shutdownSuccess = failCount === 0 && !shuttingDown;

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
      shutdownInitiated: shuttingDown,
    },
    'Agent run complete'
  );

  // Machine-readable artefact for downstream consumers, written on success and
  // failure alike (#843).
  writeRunSummary(
    buildRunSummary({
      agentAddress: AGENT_ADDRESS,
      agentName: AGENT_NAME,
      startedAt: runStart,
      tasks: taskResults,
      totalUsdcSpent,
      scoreBefore: scoreAfterRegistration,
      scoreAfter: finalScore,
      unresolvedPayments,
      shutdownInitiated: shuttingDown,
    }),
    { logger },
  );

  if (shuttingDown) {
    await completeShutdown(shutdownSuccess, unresolvedPayments);
  }
}

// ── Entry point guard ─────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.on('SIGTERM', async () => {
    await initiateShutdown('SIGTERM');
  });
  process.on('SIGINT', async () => {
    await initiateShutdown('SIGINT');
  });
  main().catch((err) => {
    logger.error({ err }, 'Agent crashed');
    // A crash is still a run outcome — emit the artefact before exiting (#843).
    writeRunSummary(
      buildRunSummary({
        agentAddress: AGENT_ADDRESS,
        agentName: AGENT_NAME,
        startedAt: Date.now(),
        tasks: [],
        error: err,
      }),
      { logger },
    );
    process.exit(1);
  });
}
