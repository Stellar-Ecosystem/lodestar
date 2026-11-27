import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listAgents, recordPaymentOnChain } from '../../src/lib/contract.js';
import logger from '../../src/lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deploymentsPath = path.resolve(__dirname, '../../..', 'contract/deployments.json');
let knownContractIds = [];
try {
  const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8'));
  knownContractIds = (deployments.contracts ?? []).map((c) => c.contractId).filter(Boolean);
} catch (err) {
  logger.warn({ err }, 'Could not load deployments.json');
}

const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

export function validateBoostConfig(env = process.env) {
  if (env.DEMO_MODE !== 'true' && env.DEMO_MODE !== '1') {
    throw new Error('Refusing to run: set DEMO_MODE=true (demo-only script)');
  }
  if (!env.STELLAR_NETWORK_PASSPHRASE || env.STELLAR_NETWORK_PASSPHRASE === MAINNET_PASSPHRASE) {
    throw new Error('Refusing to run: demo-only script requires testnet passphrase');
  }
  if (env.AGENTS_CONTRACT_ID && knownContractIds.includes(env.AGENTS_CONTRACT_ID)) {
    throw new Error('Refusing to run: target contract is a known deployment');
  }
}

const TARGETS = [110, 600, 1000];
const AMOUNT = 10_000n;

export async function boost({ dryRun = false, targets = TARGETS, amount = AMOUNT } = {}) {
  try {
    validateBoostConfig();
    if (!dryRun && !process.env.AGENTS_CONTRACT_ID) {
      throw new Error('AGENTS_CONTRACT_ID not set');
    }

    const agents = await listAgents(10);
    const sorted = [...agents].sort((a, b) => a.registered_at - b.registered_at);
    for (let i = 0; i < Math.min(sorted.length, targets.length); i++) {
      const agent = sorted[i];
      const needed = Math.max(0, Math.ceil((targets[i] - agent.score) / 10));
      for (let j = 0; j < needed; j++) {
        if (!dryRun) await recordPaymentOnChain(agent.address, 1, amount, true);
      }
      logger.info({ name: agent.name, target: targets[i] }, 'boosted');
    }
    logger.info({ dryRun }, 'complete');
  } catch (err) {
    logger.error({ err }, 'boost-scores failed');
    throw err;
  }
}

if (process.argv[1]?.endsWith('/demo/boost-scores.js') || process.argv[1]?.endsWith('\\demo\\boost-scores.js')) {
  boost({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
