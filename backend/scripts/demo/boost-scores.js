import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listAgents, getAgent, recordPaymentOnChain } from '../../src/lib/contract.js';
import logger from '../../src/lib/logger.js';

const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
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
// Service ID the server keypair is registered as provider for (weather service).
const DEMO_SERVICE_ID = 1;

export async function boost({ dryRun = false, targets = TARGETS, amount = AMOUNT } = {}) {
  const demoMode = process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1';
  const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE;
  const agentsContractId = process.env.AGENTS_CONTRACT_ID;

  if (!demoMode) {
    logger.error('Refusing to run: set DEMO_MODE=true (demo-only script)');
    process.exit(1);
  }
  if (!passphrase || passphrase === MAINNET_PASSPHRASE) {
    logger.error('Refusing to run: demo-only script requires testnet passphrase');
    process.exit(1);
  }
  if (agentsContractId && knownContractIds.includes(agentsContractId)) {
    logger.error('Refusing to run: target contract is a known deployment');
    process.exit(1);
  }
  if (!dryRun && !agentsContractId) {
    logger.error('AGENTS_CONTRACT_ID not set');
    process.exit(1);
  }

  try {
    const agents = await listAgents(10);
    const sorted = [...agents].sort((a, b) => a.registered_at - b.registered_at);
    for (let i = 0; i < Math.min(sorted.length, targets.length); i++) {
      const agent = sorted[i];
      const target = targets[i];

      // Re-read live score so a partial re-run never issues duplicate payments.
      const live = dryRun ? agent : (await getAgent(agent.address) ?? agent);
      const needed = Math.max(0, Math.ceil((target - live.score) / 10));

      if (needed === 0) {
        logger.info({ name: agent.name, score: live.score }, 'Score already at target — skipping');
        continue;
      }

      logger.info({ name: agent.name, targetScore: target, payments: needed }, 'Building score…');

      for (let j = 0; j < needed; j++) {
        if (!dryRun) await recordPaymentOnChain(agent.address, DEMO_SERVICE_ID, amount, true);
      }

      if (!dryRun) {
        logger.info({ name: agent.name, targetScore: target }, 'Done');
      }
    }
    logger.info({ dryRun }, 'Score boost complete');
  } catch (err) {
    logger.error({ err }, 'boost-scores failed');
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('/demo/boost-scores.js') || process.argv[1]?.endsWith('\\demo\\boost-scores.js')) {
  boost({ dryRun: process.argv.includes('--dry-run') });
}
