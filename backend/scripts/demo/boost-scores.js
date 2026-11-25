import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listAgents, recordPaymentOnChain } from '../../src/lib/contract.js';
import logger from '../../src/lib/logger.js';

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
export const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
export const MAX_SEED_AGENTS = 100;

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const STELLAR_SECRET_RE = /^S[A-Z2-7]{55}$/;
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deploymentsPath = path.resolve(__dirname, '../../..', 'contract/deployments.json');

export function loadKnownContractIds(filePath = deploymentsPath) {
  try {
    const deployments = JSON.parse(readFileSync(filePath, 'utf8'));
    return (deployments.contracts ?? []).map((c) => c.contractId).filter(Boolean);
  } catch (err) {
    logger.warn({ err }, 'Could not load deployments.json');
    return [];
  }
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isMainnetRpcUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const full = parsed.href.toLowerCase();
    if (host === 'horizon.stellar.org' || host === 'soroban-rpc.mainnet.stellar.gateway.fm') {
      return true;
    }
    return full.includes('mainnet') || full.includes('pubnet');
  } catch {
    return false;
  }
}

/**
 * Validate network, address, token, and service configuration for demo score seeding.
 * Fails closed before any on-chain signing and never includes secret values in errors.
 */
export function validateBoostConfig(
  env = process.env,
  {
    dryRun = false,
    knownContractIds = null,
    limit = MAX_SEED_AGENTS,
    targets = TARGETS,
    amount = AMOUNT,
  } = {},
) {
  const errors = [];

  const demoMode = env.DEMO_MODE === 'true' || env.DEMO_MODE === '1';
  if (!demoMode) {
    errors.push('DEMO_MODE must be set to "true" or "1" (demo-only script)');
  }

  // Network validation (testnet only)
  const network = (env.STELLAR_NETWORK ?? 'testnet').trim().toLowerCase();
  if (network !== 'testnet') {
    errors.push('STELLAR_NETWORK must be "testnet" for demo score seeding');
  }

  const passphrase = env.STELLAR_NETWORK_PASSPHRASE?.trim();
  if (!passphrase) {
    errors.push('STELLAR_NETWORK_PASSPHRASE is not set');
  } else if (passphrase === MAINNET_PASSPHRASE || passphrase !== TESTNET_PASSPHRASE) {
    errors.push('STELLAR_NETWORK_PASSPHRASE must be the Stellar testnet passphrase');
  }

  const rpcUrl = env.STELLAR_RPC_URL?.trim();
  if (!rpcUrl) {
    errors.push('STELLAR_RPC_URL is not set');
  } else if (!isValidHttpUrl(rpcUrl)) {
    errors.push('STELLAR_RPC_URL must be a valid http(s) URL');
  } else if (isMainnetRpcUrl(rpcUrl)) {
    errors.push('STELLAR_RPC_URL must point to testnet, not mainnet');
  }

  // Known non-demo deployments
  const nonDemoIds = new Set([
    ...(knownContractIds ?? loadKnownContractIds()),
    ...(env.KNOWN_NON_DEMO_CONTRACT_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ]);

  // Service & contract settings
  const agentsContractId = env.AGENTS_CONTRACT_ID?.trim();
  if (!agentsContractId) {
    errors.push('AGENTS_CONTRACT_ID is not set');
  } else if (!CONTRACT_ID_RE.test(agentsContractId)) {
    errors.push('AGENTS_CONTRACT_ID must be a valid Stellar contract ID (C...)');
  } else if (nonDemoIds.has(agentsContractId)) {
    errors.push('AGENTS_CONTRACT_ID matches a known non-demo deployment');
  }

  const registryContractId = env.CONTRACT_ID?.trim();
  if (!registryContractId) {
    errors.push('CONTRACT_ID is not set');
  } else if (!CONTRACT_ID_RE.test(registryContractId)) {
    errors.push('CONTRACT_ID must be a valid Stellar contract ID (C...)');
  } else if (nonDemoIds.has(registryContractId)) {
    errors.push('CONTRACT_ID matches a known non-demo deployment');
  }

  const facilitatorUrl = env.FACILITATOR_URL?.trim();
  if (facilitatorUrl && !isValidHttpUrl(facilitatorUrl)) {
    errors.push('FACILITATOR_URL must be a valid http(s) URL');
  }

  // Token settings
  const usdcContractId = env.USDC_CONTRACT_ID?.trim();
  if (!usdcContractId) {
    errors.push('USDC_CONTRACT_ID is not set');
  } else if (!CONTRACT_ID_RE.test(usdcContractId)) {
    errors.push('USDC_CONTRACT_ID must be a valid Stellar contract ID (C...)');
  }

  // Address & signing settings (never include secret values in error messages)
  const serverAddress = env.SERVER_STELLAR_ADDRESS?.trim();
  if (!serverAddress) {
    errors.push('SERVER_STELLAR_ADDRESS is not set');
  } else if (!STELLAR_ADDRESS_RE.test(serverAddress)) {
    errors.push('SERVER_STELLAR_ADDRESS must be a valid Stellar public key (G...)');
  }

  const paymentAddress = env.PAYMENT_ADDRESS?.trim();
  if (paymentAddress && !STELLAR_ADDRESS_RE.test(paymentAddress)) {
    errors.push('PAYMENT_ADDRESS must be a valid Stellar public key (G...)');
  }

  const serverSecret = env.SERVER_STELLAR_SECRET?.trim();
  if (!dryRun) {
    if (!serverSecret) {
      errors.push('SERVER_STELLAR_SECRET is not set');
    } else if (!STELLAR_SECRET_RE.test(serverSecret)) {
      errors.push('SERVER_STELLAR_SECRET must be a valid Stellar secret key (S...)');
    }
  } else if (serverSecret && !STELLAR_SECRET_RE.test(serverSecret)) {
    errors.push('SERVER_STELLAR_SECRET must be a valid Stellar secret key (S...)');
  }

  // Seeding bounds for up to 100 agents on testnet
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEED_AGENTS) {
    errors.push(`limit must be an integer between 1 and ${MAX_SEED_AGENTS}`);
  }

  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_SEED_AGENTS) {
    errors.push(`targets must be a non-empty array of at most ${MAX_SEED_AGENTS} scores`);
  } else if (targets.some((t) => !Number.isInteger(t) || t < 0 || t > 1000)) {
    errors.push('targets must contain integer scores between 0 and 1000');
  }

  if (typeof amount !== 'bigint' || amount <= 0n) {
    errors.push('amount must be a positive bigint in stroops');
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

const TARGETS = [110, 600, 1000];
const AMOUNT = 10_000n;

export async function boost({
  dryRun = false,
  targets = TARGETS,
  amount = AMOUNT,
  limit = Math.min(Math.max(targets.length, 10), MAX_SEED_AGENTS),
  env = process.env,
  knownContractIds = null,
} = {}) {
  const validation = validateBoostConfig(env, {
    dryRun,
    knownContractIds,
    limit,
    targets,
    amount,
  });

  if (!validation.ok) {
    logger.error({ errors: validation.errors }, 'Refusing to run boost-scores: invalid configuration');
    throw new Error(`Invalid boost-scores configuration: ${validation.errors.join('; ')}`);
  }

  const agents = await listAgents(limit);
  const sorted = [...agents].sort(
    (a, b) =>
      a.registered_at - b.registered_at ||
      String(a.address ?? '').localeCompare(String(b.address ?? '')),
  );

  const results = [];
  let boostedCount = 0;
  let skippedCount = 0;
  let totalPayments = 0;

  for (let i = 0; i < Math.min(sorted.length, targets.length); i++) {
    const agent = sorted[i];
    const targetScore = targets[i];
    const needed = Math.max(0, Math.ceil((targetScore - agent.score) / 10));
    const expectedScore = Math.min(1000, agent.score + needed * 10);

    if (needed === 0) {
      skippedCount += 1;
      results.push({
        address: agent.address,
        name: agent.name,
        previousScore: agent.score,
        targetScore,
        expectedScore: agent.score,
        payments: 0,
        status: 'skipped',
      });
      logger.info({ name: agent.name, score: agent.score }, 'Score already at target — skipping');
      continue;
    }

    logger.info({ name: agent.name, payments: needed, targetScore, dryRun }, 'Building score…');

    for (let j = 0; j < needed; j++) {
      if (!dryRun) await recordPaymentOnChain(agent.address, amount, true);
    }

    boostedCount += 1;
    totalPayments += needed;
    results.push({
      address: agent.address,
      name: agent.name,
      previousScore: agent.score,
      targetScore,
      expectedScore,
      payments: needed,
      status: dryRun ? 'planned' : 'boosted',
    });

    logger.info({ name: agent.name, targetScore }, 'Done');
  }

  const summary = {
    dryRun,
    network: 'testnet',
    totalAgents: sorted.length,
    processedCount: results.length,
    boostedCount,
    skippedCount,
    totalPayments,
    results,
  };

  logger.info(
    {
      dryRun,
      processedCount: summary.processedCount,
      boostedCount: summary.boostedCount,
      skippedCount: summary.skippedCount,
      totalPayments: summary.totalPayments,
    },
    'Score boost complete',
  );

  return summary;
}

const isCli =
  process.argv[1]?.endsWith('/demo/boost-scores.js') ||
  process.argv[1]?.endsWith('\\demo\\boost-scores.js');

if (isCli) {
  boost({ dryRun: process.argv.includes('--dry-run') }).catch((err) => {
    logger.error({ err: err?.message ?? 'boost-scores failed' }, 'boost-scores failed');
    process.exit(1);
  });
}
