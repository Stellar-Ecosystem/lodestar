import 'dotenv/config';
import pkg from '@stellar/stellar-sdk';
const { Keypair } = pkg;
import { getAgentCount, getAgent, registerAgentOnChain, recordPaymentOnChain } from '../src/lib/contract.js';
import config from '../src/config.js';
import logger from '../src/lib/logger.js';

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

export function validateDemoSeedingConfig(env = process.env) {
  if (!env.AGENTS_CONTRACT_ID) {
    throw new Error('AGENTS_CONTRACT_ID not set — deploy the agents contract first');
  }
  if (env.STELLAR_NETWORK === 'mainnet' || env.STELLAR_NETWORK_PASSPHRASE === MAINNET_PASSPHRASE) {
    throw new Error('Refusing to seed demo agents on mainnet');
  }
  if (env.STELLAR_NETWORK_PASSPHRASE !== TESTNET_PASSPHRASE) {
    throw new Error('Demo agent seeding requires the Stellar testnet network');
  }
}

// Register the server key as an agent so it can cast reputation votes for the
// demo (the backend signs reputation votes with this key by default — see
// config.demo.voterSecrets). Idempotent: skips if already registered.
//
// Throws on failure: reputation voting is broken if the demo voter isn't a
// registered agent, so we must not leave the deployment in that state silently.
async function ensureServerVoterRegistered() {
  const address = config.server.address;
  const existing = await getAgent(address);
  if (existing) {
    logger.info({ address }, 'Server voter agent already registered — skipping');
    return;
  }
  logger.info({ address }, 'Registering server key as reputation voter agent…');
  await registerAgentOnChain(address, 'Lodestar Demo Voter', 'Backend demo agent used to cast reputation votes.');
  logger.info({ address }, 'Server voter agent registered');
}

// Use env secrets if provided, otherwise generate ephemeral keypairs.
// Re-runs are idempotent via the agent count check.
function resolveKeypair(envKey, index) {
  const secret = process.env[envKey];
  if (secret) {
    try {
      return Keypair.fromSecret(secret);
    } catch {
      logger.warn({ envKey }, 'Invalid secret in env — generating deterministic keypair');
    }
  }
  const seed = new Uint8Array(32);
  seed.fill(index + 1);
  return Keypair.fromRawEd25519Seed(seed);
}

export const AGENTS = Array.from({ length: 100 }, (_, index) => {
  if (index === 0) {
    return {
      keypair: resolveKeypair('DEMO_AGENT_1_SECRET', index),
      name: 'NewAgent',
      description: 'A freshly registered agent. Just getting started on the Lodestar network.',
      successPayments: 1,
      failPayments: 0,
    };
  }
  if (index === 1) {
    return {
      keypair: resolveKeypair('DEMO_AGENT_2_SECRET', index),
      name: 'EstablishedAgent',
      description: 'Mid-tier agent with a solid track record of successful x402 payments.',
      successPayments: 50,
      failPayments: 0,
    };
  }
  if (index === 2) {
    return {
      keypair: resolveKeypair('DEMO_AGENT_3_SECRET', index),
      name: 'TrustedAgent',
      description: 'High-trust agent. Consistent payment history across weather, search, and finance services.',
      successPayments: 90,
      failPayments: 0,
    };
  }
  return {
    keypair: resolveKeypair(`DEMO_AGENT_${index + 1}_SECRET`, index),
    name: `DemoAgent${index + 1}`,
    description: 'Deterministic demo agent used for testnet score seeding.',
    successPayments: (index * 7) % 91,
    failPayments: 0,
  };
});

export async function seed() {
  try {
    validateDemoSeedingConfig();
    await ensureServerVoterRegistered();

    const count = await getAgentCount();
    logger.info({ count }, 'Current agent count');

    for (const agent of AGENTS) {
      const address = agent.keypair.publicKey();
      try {
        const existing = await getAgent(address);
        const targetScore = Math.min(1000, Math.max(0, 100 + agent.successPayments * 10 - agent.failPayments * 25));

        if (!existing) {
          await registerAgentOnChain(address, agent.name, agent.description);
        } else if (existing.score >= targetScore) {
          logger.info({ name: agent.name, address, score: existing.score }, 'Agent already seeded — skipping');
          continue;
        }

        const currentScore = existing?.score ?? 100;
        const needed = Math.max(0, Math.ceil((targetScore - currentScore) / 10));
        const AMOUNT = 10_000n;
        for (let i = 0; i < needed; i++) {
          await recordPaymentOnChain(address, 1, AMOUNT, true);
        }

        logger.info({ name: agent.name, targetScore, payments: needed }, 'Agent seeding complete');
      } catch (err) {
        logger.error({ err, name: agent.name }, 'Failed to seed agent');
      }
    }

    logger.info('Agent seed complete');
  } catch (err) {
    logger.error({ err }, 'Seed-agents script failed');
    throw err;
  }
}

if (process.argv[1]?.endsWith('/scripts/seed-agents.js') || process.argv[1]?.endsWith('\\scripts\\seed-agents.js')) {
  seed()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
