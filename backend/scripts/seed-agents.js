import 'dotenv/config';
import pkg from '@stellar/stellar-sdk';
const { Keypair } = pkg;
import { getAgentCount, getAgent, registerAgentOnChain, recordPaymentOnChain } from '../src/lib/contract.js';
import config from '../src/config.js';
import logger from '../src/lib/logger.js';

if (!process.env.AGENTS_CONTRACT_ID) {
  logger.error('AGENTS_CONTRACT_ID not set — deploy the agents contract first');
  process.exit(1);
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
  await registerAgentOnChain(address, 'Lodestar Demo Voter', 'Backend demo agent used to cast reputation votes.', true);
  logger.info({ address }, 'Server voter agent registered');
}

// Use env secrets if provided, otherwise generate ephemeral keypairs.
// Re-runs are idempotent via the agent count check.
function resolveKeypair(envKey) {
  const secret = process.env[envKey];
  if (secret) {
    try {
      return Keypair.fromSecret(secret);
    } catch {
      logger.warn({ envKey }, 'Invalid secret in env — generating random keypair');
    }
  }
  return Keypair.random();
}

const AGENTS = [
  {
    keypair: resolveKeypair('DEMO_AGENT_1_SECRET'),
    name: 'NewAgent',
    description: 'A freshly registered agent. Just getting started on the Lodestar network.',
    successPayments: 1,   // score → 110
    failPayments: 0,
  },
  {
    keypair: resolveKeypair('DEMO_AGENT_2_SECRET'),
    name: 'EstablishedAgent',
    description: 'Mid-tier agent with a solid track record of successful x402 payments.',
    successPayments: 50,  // score → 600
    failPayments: 0,
  },
  {
    keypair: resolveKeypair('DEMO_AGENT_3_SECRET'),
    name: 'TrustedAgent',
    description: 'High-trust agent. Consistent payment history across weather, search, and finance services.',
    successPayments: 90,  // score → 1000 (capped)
    failPayments: 0,
  },
];

async function seed() {
  try {
    // Always ensure the demo voter exists, even if the demo agents are seeded.
    await ensureServerVoterRegistered();

    const count = await getAgentCount();
    logger.info({ count }, 'Current agent count');

    // count now includes the server voter registered above, so the demo agents
    // are fully seeded only once the count reaches AGENTS.length + 1.
    const expectedCount = AGENTS.length + 1;
    if (count >= expectedCount) {
      logger.info('Agents already seeded — skipping');
      process.exit(0);
    }

    for (const agent of AGENTS) {
      const address = agent.keypair.publicKey();
      try {
        logger.info({ name: agent.name, address }, 'Registering agent…');
        await registerAgentOnChain(address, agent.name, agent.description, true);
        logger.info({ name: agent.name }, 'Registered — building payment history…');

        const SERVICE_ID = 1; // Use first registered service (or demo service)
        const AMOUNT = 10_000n; // 0.001 USDC in stroops

        for (let i = 0; i < agent.successPayments; i++) {
          await recordPaymentOnChain(address, SERVICE_ID, AMOUNT, true);
        }
        for (let i = 0; i < agent.failPayments; i++) {
          await recordPaymentOnChain(address, SERVICE_ID, AMOUNT, false);
        }

        const finalScore = Math.min(
          1000,
          Math.max(0, 100 + agent.successPayments * 10 - agent.failPayments * 25)
        );
        logger.info(
          { name: agent.name, payments: agent.successPayments + agent.failPayments, finalScore },
          'Payment history recorded'
        );
      } catch (err) {
        logger.error({ err, name: agent.name }, 'Failed to seed agent');
      }
    }

    logger.info('Agent seed complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Seed-agents script failed');
    process.exit(1);
  }
}

seed();
