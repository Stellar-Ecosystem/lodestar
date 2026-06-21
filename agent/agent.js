import 'dotenv/config';
import crypto from 'crypto';
import pino from 'pino';
import pkg from '@stellar/stellar-sdk';
const { Keypair } = pkg;
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/client';

// -- Config -------------------------------------------------------------------

const required = ['AGENT_STELLAR_SECRET', 'STELLAR_RPC_URL', 'LODESTAR_API_URL'];
for (const key of required) {
  if (!process.env[key]) throw new Error('Missing required env var: ' + key);
}

const AGENT_SECRET = process.env.AGENT_STELLAR_SECRET;
const RPC_URL = process.env.STELLAR_RPC_URL;
const STELLAR_NETWORK = process.env.STELLAR_NETWORK ?? 'testnet';
const LODESTAR_API_URL = process.env.LODESTAR_API_URL;
const LODESTAR_HMAC_SECRET = process.env.LODESTAR_HMAC_SECRET ?? '';
const AGENT_NAME = process.env.AGENT_NAME ?? 'LodestarAgent';
const AGENT_DESC = process.env.AGENT_DESC ?? 'Autonomous x402 agent powered by Lodestar service discovery';
const MAX_PER_TX = process.env.AGENT_MAX_PER_TX ?? '0.001';
const MAX_PER_DAY = process.env.AGENT_MAX_PER_DAY ?? '1.00';
const ALLOWED_CATS = (process.env.AGENT_ALLOWED_CATEGORIES ?? '').split(',').filter(Boolean);
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

const agentKeypair = Keypair.fromSecret(AGENT_SECRET);
const AGENT_ADDRESS = agentKeypair.publicKey();

const logger = pino({
  level: LOG_LEVEL,
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const EVENTS = Object.freeze({
  AGENT_START: 'agent_start',
  AGENT_ADDRESS_LOADED: 'agent_address_loaded',
  AGENT_REGISTERED: 'agent_registered',
  AGENT_REGISTRATION_STARTED: 'agent_registration_started',
  AGENT_REGISTRATION_FAILED: 'agent_registration_failed',
  SCORING_DISABLED: 'scoring_disabled',
  TASK_START: 'task_start',
  REGISTRY_QUERY: 'registry_query',
  REGISTRY_EMPTY: 'registry_empty',
  SERVICE_SELECTED: 'service_selected',
  SPEND_CHECK_PASSED: 'spend_check_passed',
  SPEND_CHECK_BLOCKED: 'spend_check_blocked',
  PAYMENT_STARTED: 'payment_started',
  PAYMENT_SUCCESS: 'payment_success',
  PAYMENT_RESPONSE_PARSE_FAILED: 'payment_response_parse_failed',
  PAYMENT_FAILED: 'payment_failed',
  SCORE_UPDATED: 'score_updated',
  SCORE_UPDATE_FAILED: 'score_update_failed',
  REPUTATION_SUBMITTED: 'reputation_submitted',
  AGENT_SUMMARY: 'agent_summary',
  AGENT_COMPLETE: 'agent_complete',
  AGENT_CRASHED: 'agent_crashed',
});

// -- Credit scoring helpers ---------------------------------------------------

let currentScore = null;

/**
 * Builds the shared structured logging context for every agent event.
 */
function agentContext(fields = {}) {
  const base = {
    agentName: AGENT_NAME,
    agentAddress: AGENT_ADDRESS,
  };

  if (currentScore !== null) {
    base.score = currentScore;
  }

  return { ...base, ...fields };
}

/**
 * Calculates elapsed wall-clock time for task and run summaries.
 */
function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}

/**
 * Safely normalizes string or numeric USDC values for log fields.
 */
function usdcNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Converts Stellar stroops into decimal USDC for human-readable policy logs.
 */
function stroopsToUsdc(value) {
  if (value === undefined || value === null) return undefined;
  return Number(BigInt(value)) / 10_000_000;
}

/**
 * Finds or creates the agent registration and loads its current score.
 */
async function ensureRegistered() {
  try {
    const res = await fetch(LODESTAR_API_URL + '/api/agents/' + AGENT_ADDRESS);
    if (res.status === 503) {
      logger.info(
        agentContext({ event: EVENTS.SCORING_DISABLED, reason: 'agents_contract_unavailable' }),
        'Agents contract not deployed; scoring disabled'
      );
      return false;
    }

    if (res.ok) {
      const data = await res.json();
      const agent = data.agent ?? data;
      const policy = data.policy;
      const scoreBefore = currentScore;
      currentScore = agent.score;

      logger.info(
        agentContext({
          event: EVENTS.AGENT_REGISTERED,
          registrationStatus: 'existing',
          scoreBefore,
          scoreAfter: currentScore,
          maxPerDayUsdc: policy ? stroopsToUsdc(policy.max_per_day_stroops) : undefined,
        }),
        'Agent registration found'
      );
      return true;
    }

    if (res.status === 404) {
      logger.info(
        agentContext({ event: EVENTS.AGENT_REGISTRATION_STARTED }),
        'Registering agent'
      );

      const regRes = await fetch(LODESTAR_API_URL + '/api/agents/register', {
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
        const regData = await regRes.json().catch(() => ({}));
        const registeredAgent = regData.agent ?? regData;
        const registeredScore = Number(registeredAgent.score);
        currentScore = Number.isFinite(registeredScore) ? registeredScore : 100;
        logger.info(
          agentContext({
            event: EVENTS.AGENT_REGISTERED,
            registrationStatus: 'created',
            scoreBefore: null,
            scoreAfter: currentScore,
            maxPerTxUsdc: usdcNumber(MAX_PER_TX),
            maxPerDayUsdc: usdcNumber(MAX_PER_DAY),
            allowedCategories: ALLOWED_CATS,
          }),
          'Agent registered'
        );
        return true;
      }

      const err = await regRes.json().catch(() => ({}));
      logger.warn(
        agentContext({ event: EVENTS.AGENT_REGISTRATION_FAILED, err }),
        'Agent registration failed; scoring disabled'
      );
      return false;
    }
  } catch (err) {
    logger.warn(
      agentContext({ event: EVENTS.SCORING_DISABLED, error: err.message }),
      'Could not reach agents API; scoring disabled'
    );
  }

  return false;
}

/**
 * Asks the policy API whether a planned service payment is allowed.
 */
async function checkSpend(amountUsdc, category) {
  try {
    const res = await fetch(
      LODESTAR_API_URL + '/api/agents/' + AGENT_ADDRESS + '/can-spend' +
      '?amount=' + encodeURIComponent(amountUsdc) + '&category=' + encodeURIComponent(category)
    );
    if (!res.ok) return { allowed: true, reason: 'OK' };
    return await res.json();
  } catch {
    return { allowed: true, reason: 'OK' };
  }
}

/**
 * Records a payment outcome so the agent score can be updated consistently.
 */
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

    const res = await fetch(LODESTAR_API_URL + '/api/agents/' + AGENT_ADDRESS + '/payment', {
      method: 'POST',
      headers,
      body,
    });

    if (res.ok) {
      const data = await res.json();
      const scoreBefore = currentScore;
      currentScore = data.newScore;
      const scoreDelta = scoreBefore !== null && currentScore !== null ? currentScore - scoreBefore : null;

      logger.info(
        agentContext({
          event: EVENTS.SCORE_UPDATED,
          amountUsdc: usdcNumber(amountUsdc),
          serviceId,
          success,
          scoreBefore,
          scoreAfter: currentScore,
          scoreDelta,
        }),
        'Agent score updated'
      );

      return { scoreBefore, scoreAfter: currentScore, scoreDelta };
    }
  } catch (err) {
    logger.warn(
      agentContext({
        event: EVENTS.SCORE_UPDATE_FAILED,
        amountUsdc: usdcNumber(amountUsdc),
        serviceId,
        success,
        error: err.message,
      }),
      'Score update failed'
    );
  }

  return null;
}

// -- x402 client --------------------------------------------------------------

/**
 * Creates an x402-aware HTTP client for the configured Stellar network.
 */
function buildHttpClient() {
  const signer = createEd25519Signer(AGENT_SECRET, `stellar:${STELLAR_NETWORK}`);
  const scheme = new ExactStellarScheme(signer, { url: RPC_URL });
  const x402 = new x402Client().register('stellar:*', scheme);
  const httpClient = new x402HTTPClient(x402);

  // Implement fetch manually because x402HTTPClient.fetch() was removed in this version.
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

// -- Registry helpers ---------------------------------------------------------

/**
 * Fetches available services in the requested category from the registry API.
 */
async function fetchServices(category) {
  const res = await fetch(LODESTAR_API_URL + '/api/services?category=' + encodeURIComponent(category));
  if (!res.ok) throw new Error('Registry fetch failed: ' + res.status);
  const body = await res.json();
  return body.services ?? [];
}

/**
 * Submits a reputation vote for the selected service without blocking the run.
 */
async function submitReputation(id, positive) {
  await fetch(LODESTAR_API_URL + '/api/reputation/' + id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positive }),
  }).catch(() => {});
}

// -- Agent task ---------------------------------------------------------------

/**
 * Runs one paid service task and returns a structured result summary.
 */
async function runTask(category, buildUrl, scoringEnabled) {
  const startedAt = Date.now();
  logger.info(agentContext({ event: EVENTS.TASK_START, category }), 'Starting agent task');
  logger.info(agentContext({ event: EVENTS.REGISTRY_QUERY, category }), 'Querying Lodestar registry');

  const services = await fetchServices(category);

  if (!services.length) {
    const taskDurationMs = elapsedMs(startedAt);
    logger.error(
      agentContext({ event: EVENTS.REGISTRY_EMPTY, category, taskDurationMs }),
      'No services found for category'
    );
    return { category, success: false, amountUsdc: 0, taskDurationMs, reason: 'no_services' };
  }

  const best = [...services].sort((a, b) => b.reputation - a.reputation)[0];
  const priceUsdc = best.price_usdc;
  logger.info(
    agentContext({
      event: EVENTS.SERVICE_SELECTED,
      category,
      serviceId: best.id,
      serviceName: best.name,
      priceUsdc: usdcNumber(priceUsdc),
      reputation: best.reputation,
      serviceCount: services.length,
    }),
    'Selected service'
  );

  if (scoringEnabled) {
    const check = await checkSpend(priceUsdc, category);
    if (!check.allowed) {
      const taskDurationMs = elapsedMs(startedAt);
      logger.warn(
        agentContext({
          event: EVENTS.SPEND_CHECK_BLOCKED,
          category,
          serviceId: best.id,
          serviceName: best.name,
          priceUsdc: usdcNumber(priceUsdc),
          reason: check.reason,
          taskDurationMs,
        }),
        'Payment blocked by spending policy'
      );
      return {
        category,
        serviceId: best.id,
        serviceName: best.name,
        success: false,
        amountUsdc: 0,
        taskDurationMs,
        reason: check.reason,
      };
    }

    logger.info(
      agentContext({
        event: EVENTS.SPEND_CHECK_PASSED,
        category,
        serviceId: best.id,
        serviceName: best.name,
        priceUsdc: usdcNumber(priceUsdc),
      }),
      'Spending policy check passed'
    );
  }

  const endpointUrl = buildUrl(best.endpoint);
  logger.info(
    agentContext({
      event: EVENTS.PAYMENT_STARTED,
      category,
      serviceId: best.id,
      serviceName: best.name,
      priceUsdc: usdcNumber(priceUsdc),
    }),
    'Sending x402 payment on Stellar'
  );

  const httpClient = buildHttpClient();
  let response;
  try {
    response = await httpClient.fetch(endpointUrl);
  } catch (err) {
    const taskDurationMs = elapsedMs(startedAt);
    logger.error(
      agentContext({
        event: EVENTS.PAYMENT_FAILED,
        category,
        serviceId: best.id,
        serviceName: best.name,
        priceUsdc: usdcNumber(priceUsdc),
        taskDurationMs,
        error: err.message,
      }),
      'x402 payment failed'
    );
    if (scoringEnabled) await recordOutcome(priceUsdc, false, best.id);
    return {
      category,
      serviceId: best.id,
      serviceName: best.name,
      success: false,
      amountUsdc: 0,
      taskDurationMs,
      reason: 'payment_failed',
    };
  }

  if (!response.ok) {
    const taskDurationMs = elapsedMs(startedAt);
    logger.error(
      agentContext({
        event: EVENTS.PAYMENT_FAILED,
        category,
        serviceId: best.id,
        serviceName: best.name,
        priceUsdc: usdcNumber(priceUsdc),
        status: response.status,
        taskDurationMs,
      }),
      'Service error after payment'
    );
    if (scoringEnabled) await recordOutcome(priceUsdc, false, best.id);
    return {
      category,
      serviceId: best.id,
      serviceName: best.name,
      success: false,
      amountUsdc: 0,
      taskDurationMs,
      reason: 'service_error',
    };
  }

  const txHash = response.headers.get('x-payment-transaction') ?? '(no hash)';
  let data = null;
  let parseError = null;
  try {
    data = await response.json();
  } catch (err) {
    parseError = err;
  }
  const scoreBefore = currentScore;
  if (scoringEnabled) await recordOutcome(priceUsdc, true, best.id);

  await submitReputation(best.id, true);
  const taskDurationMs = elapsedMs(startedAt);

  if (parseError) {
    logger.warn(
      agentContext({
        event: EVENTS.PAYMENT_RESPONSE_PARSE_FAILED,
        category,
        serviceId: best.id,
        serviceName: best.name,
        txHash,
        error: parseError.message,
      }),
      'Payment response body was not valid JSON'
    );
  }

  logger.info(
    agentContext({
      event: EVENTS.PAYMENT_SUCCESS,
      category,
      serviceId: best.id,
      serviceName: best.name,
      priceUsdc: usdcNumber(priceUsdc),
      txHash,
      scoreBefore,
      scoreAfter: currentScore,
      taskDurationMs,
      responseJsonParsed: parseError === null,
      responseKeys: data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : undefined,
    }),
    'Payment completed and data received'
  );

  logger.info(
    agentContext({
      event: EVENTS.REPUTATION_SUBMITTED,
      category,
      serviceId: best.id,
      serviceName: best.name,
      positive: true,
    }),
    'Submitted positive reputation'
  );

  return {
    category,
    serviceId: best.id,
    serviceName: best.name,
    success: true,
    amountUsdc: usdcNumber(priceUsdc),
    txHash,
    scoreBefore,
    scoreAfter: currentScore,
    taskDurationMs,
  };
}

// -- Main ---------------------------------------------------------------------

/**
 * Coordinates registration, service execution, and final run summary logging.
 */
async function main() {
  const runStartedAt = Date.now();
  logger.info(
    agentContext({ event: EVENTS.AGENT_START, logLevel: LOG_LEVEL }),
    'Lodestar Agent starting'
  );
  logger.info(agentContext({ event: EVENTS.AGENT_ADDRESS_LOADED }), 'Agent address loaded');

  const scoringEnabled = await ensureRegistered();
  const startingScore = currentScore;

  const results = [];
  results.push(await runTask('weather', (ep) => ep + '?lat=40.7128&lon=-74.0060', scoringEnabled));
  results.push(await runTask('search', (ep) => ep + '?q=Stellar+blockchain+AI+agents', scoringEnabled));

  const successCount = results.filter((result) => result?.success).length;
  const failCount = results.length - successCount;
  const totalUsdcSpent = Number(
    results
      .filter((result) => result?.success)
      .reduce((total, result) => total + result.amountUsdc, 0)
      .toFixed(7)
  );
  const finalScore = currentScore;
  const scoreDelta = startingScore !== null && finalScore !== null ? finalScore - startingScore : null;
  const runDurationMs = elapsedMs(runStartedAt);

  logger.info(
    agentContext({
      event: EVENTS.AGENT_SUMMARY,
      totalTasks: results.length,
      successCount,
      failCount,
      totalUsdcSpent,
      finalScore,
      scoreDelta,
      runDurationMs,
    }),
    'Agent run summary'
  );

  logger.info(agentContext({ event: EVENTS.AGENT_COMPLETE, runDurationMs }), 'Agent complete');
}

main().catch((err) => {
  logger.error(agentContext({ event: EVENTS.AGENT_CRASHED, error: err.message }), 'Agent crashed');
  process.exit(1);
});
