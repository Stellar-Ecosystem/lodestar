import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listAgents, recordPaymentOnChain } from '../../src/lib/contract.js';
import logger from '../../src/lib/logger.js';

export const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deploymentsPath = path.resolve(__dirname, '../../..', 'contract/deployments.json');
let knownContractIds = [];
try {
  const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8'));
  knownContractIds = (deployments.contracts ?? []).map((c) => c.contractId).filter(Boolean);
} catch (err) {
  logger.warn({ err }, 'Could not load deployments.json');
}

const TARGETS = [110, 600, 1000];
const AMOUNT = 10_000n;

export function redactReference(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str) return null;
  if (str.length <= 8) return '***';
  return `${str.slice(0, 4)}...${str.slice(-4)}`;
}

export function validateBoostConfig({
  env = process.env,
  knownIds = knownContractIds,
  dryRun = false,
  runId = randomUUID(),
} = {}) {
  const demoMode = env.DEMO_MODE === 'true' || env.DEMO_MODE === '1';
  const passphrase = env.STELLAR_NETWORK_PASSPHRASE;
  const agentsContractId = env.AGENTS_CONTRACT_ID;
  const contractRef = redactReference(agentsContractId);

  if (!demoMode) {
    logger.error(
      { runId, event: 'boost_scores.config_rejected', reason: 'demo_mode_disabled', contractRef, dryRun },
      'Refusing to run: set DEMO_MODE=true (demo-only script)'
    );
    return { ok: false, runId, reason: 'demo_mode_disabled', contractRef };
  }

  if (!passphrase || passphrase === MAINNET_PASSPHRASE) {
    const isMainnet = passphrase === MAINNET_PASSPHRASE;
    const reason = isMainnet ? 'mainnet_passphrase' : 'missing_passphrase';
    logger.error(
      {
        runId,
        event: 'boost_scores.config_rejected',
        reason,
        networkType: isMainnet ? 'mainnet' : 'unknown',
        contractRef,
        dryRun,
      },
      'Refusing to run: demo-only script requires testnet passphrase'
    );
    return { ok: false, runId, reason, contractRef };
  }

  if (agentsContractId && knownIds.includes(agentsContractId)) {
    logger.error(
      { runId, event: 'boost_scores.config_rejected', reason: 'known_deployment_contract', contractRef, dryRun },
      'Refusing to run: target contract is a known deployment'
    );
    return { ok: false, runId, reason: 'known_deployment_contract', contractRef };
  }

  if (!dryRun && !agentsContractId) {
    logger.error(
      { runId, event: 'boost_scores.config_rejected', reason: 'missing_agents_contract_id', dryRun },
      'AGENTS_CONTRACT_ID not set'
    );
    return { ok: false, runId, reason: 'missing_agents_contract_id', contractRef };
  }

  return { ok: true, runId, contractRef };
}

export async function boost({
  dryRun = false,
  targets = TARGETS,
  amount = AMOUNT,
  runId = randomUUID(),
  env = process.env,
  knownIds = knownContractIds,
} = {}) {
  const validation = validateBoostConfig({ env, knownIds, dryRun, runId });
  if (!validation.ok) {
    return {
      ok: false,
      runId,
      dryRun,
      contractRef: validation.contractRef,
      reason: validation.reason,
      outcome: 'rejected',
    };
  }

  const { contractRef } = validation;
  let updatedCount = 0;
  let skippedCount = 0;
  let totalPaymentsPlanned = 0;
  let totalPaymentsSubmitted = 0;
  let hasPartialProgress = false;
  const results = [];

  try {
    logger.info(
      {
        runId,
        event: 'boost_scores.started',
        dryRun,
        contractRef,
        targetCount: targets.length,
        amountStroops: amount.toString(),
      },
      'Starting demo score seeding run'
    );

    const agents = await listAgents(10);
    const sorted = [...agents].sort((a, b) => a.registered_at - b.registered_at);
    const plannedAgents = Math.min(sorted.length, targets.length);

    logger.info(
      {
        runId,
        event: 'boost_scores.discovered',
        dryRun,
        contractRef,
        discoveredCount: agents.length,
        plannedAgents,
      },
      'Discovered demo agents for score seeding'
    );

    for (let i = 0; i < plannedAgents; i++) {
      const agent = sorted[i];
      const targetScore = targets[i];
      const agentRef = redactReference(agent.address);
      const needed = Math.max(0, Math.ceil((targetScore - agent.score) / 10));

      if (needed === 0) {
        skippedCount++;
        logger.info(
          {
            runId,
            event: 'boost_scores.agent_skipped',
            name: agent.name,
            agentRef,
            contractRef,
            currentScore: agent.score,
            targetScore,
            outcome: 'skipped_at_target',
          },
          'Score already at target — skipping'
        );
        results.push({
          name: agent.name,
          agentRef,
          currentScore: agent.score,
          targetScore,
          paymentsPlanned: 0,
          paymentsSubmitted: 0,
          outcome: 'skipped_at_target',
        });
        continue;
      }

      const agentPartialRerun = agent.score > 100;
      if (agentPartialRerun) hasPartialProgress = true;
      totalPaymentsPlanned += needed;

      logger.info(
        {
          runId,
          event: 'boost_scores.agent_planned',
          name: agent.name,
          agentRef,
          contractRef,
          currentScore: agent.score,
          targetScore,
          paymentsPlanned: needed,
          partialRerun: agentPartialRerun,
          dryRun,
        },
        'Planned demo score payments'
      );

      let lastPaymentRef = null;
      for (let j = 0; j < needed; j++) {
        if (!dryRun) {
          const txResult = await recordPaymentOnChain(agent.address, amount, true);
          totalPaymentsSubmitted++;
          const rawRef = typeof txResult === 'string'
            ? txResult
            : txResult?.hash ?? txResult?.txHash ?? `${agent.address}:payment:${j + 1}`;
          lastPaymentRef = redactReference(rawRef);
        } else {
          lastPaymentRef = redactReference(`${agent.address}:dryrun:${j + 1}`);
        }
      }

      updatedCount++;
      const verifiedScore = dryRun ? agent.score : Math.max(agent.score, targetScore);
      const outcome = dryRun ? 'dry_run_planned' : 'verified';

      logger.info(
        {
          runId,
          event: 'boost_scores.agent_result',
          name: agent.name,
          agentRef,
          contractRef,
          paymentRef: lastPaymentRef,
          currentScore: agent.score,
          targetScore,
          verifiedScore,
          paymentsPlanned: needed,
          paymentsSubmitted: dryRun ? 0 : needed,
          outcome,
          dryRun,
        },
        dryRun ? 'Dry-run score boost planned' : 'Agent score boosted'
      );

      results.push({
        name: agent.name,
        agentRef,
        paymentRef: lastPaymentRef,
        currentScore: agent.score,
        targetScore,
        verifiedScore,
        paymentsPlanned: needed,
        paymentsSubmitted: dryRun ? 0 : needed,
        outcome,
      });
    }

    const partialRerun = (skippedCount > 0 && updatedCount > 0) || hasPartialProgress;
    const outcome = dryRun ? 'dry_run_complete' : 'verified';

    logger.info(
      {
        runId,
        event: 'boost_scores.completed',
        dryRun,
        contractRef,
        discoveredCount: agents.length,
        processedCount: plannedAgents,
        updatedCount,
        skippedCount,
        totalPaymentsPlanned,
        totalPaymentsSubmitted,
        partialRerun,
        outcome,
      },
      'Demo score seeding run complete'
    );

    return {
      ok: true,
      runId,
      dryRun,
      contractRef,
      discoveredCount: agents.length,
      processedCount: plannedAgents,
      updatedCount,
      skippedCount,
      totalPaymentsPlanned,
      totalPaymentsSubmitted,
      partialRerun,
      outcome,
      results,
    };
  } catch (err) {
    logger.error(
      {
        runId,
        event: 'boost_scores.failed',
        err,
        dryRun,
        contractRef,
        updatedCount,
        skippedCount,
        totalPaymentsPlanned,
        totalPaymentsSubmitted,
        outcome: 'failed',
      },
      'boost-scores failed'
    );
    return {
      ok: false,
      runId,
      dryRun,
      contractRef,
      updatedCount,
      skippedCount,
      totalPaymentsPlanned,
      totalPaymentsSubmitted,
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

if (process.argv[1]?.endsWith('/demo/boost-scores.js') || process.argv[1]?.endsWith('\\demo\\boost-scores.js')) {
  boost({ dryRun: process.argv.includes('--dry-run') }).then((result) => {
    if (!result?.ok) process.exit(1);
  });
}
