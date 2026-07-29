import 'dotenv/config';
import { fileURLToPath } from 'url';
import { Address } from '@stellar/stellar-sdk';
import config from '../src/config.js';
import { listServicesByProvider, registerServiceOnChain } from '../src/lib/contract.js';
import logger from '../src/lib/logger.js';

process.env.SEEDING_MODE ??= 'true';

function printTargetInfo() {
  logger.info({
    network: config.stellar.network,
    contractId: config.contract.id,
    serverAddress: config.server.address,
  }, 'Target network and contract');
}

const SERVICES = [
  {
    name: 'Lodestar Weather Service',
    description: 'Real-time weather data for any coordinates. Returns temperature, wind speed, and weather code.',
    endpoint: 'https://lodestar-8na4.onrender.com/demo/weather',
    priceUsdc: '0.001',
    category: 'weather',
  },
  {
    name: 'Lodestar Search Service',
    description: 'Web search powered by Brave Search API. Returns top 5 results with title, URL, and description.',
    endpoint: 'https://lodestar-8na4.onrender.com/demo/search',
    priceUsdc: '0.001',
    category: 'search',
  },
  {
    name: 'Stellar Observatory',
    description: 'On-chain Stellar network analytics and monitoring data for agents.',
    endpoint: 'https://stellar-observatory.vercel.app',
    priceUsdc: '0.001',
    category: 'data',
  },
  {
    name: 'xlm402 News Service',
    description: 'AI-curated news feed from xlm402, delivered via x402 on Stellar testnet.',
    endpoint: 'https://xlm402.com/testnet/news/ai',
    priceUsdc: '0.01',
    category: 'data',
  },
];

export async function seed({ dryRun = false } = {}) {
  try {
    const providerAddress = Address.fromString(config.server.address).toString();
    const existingServices = await listServicesByProvider(providerAddress);
    const existingNames = new Set(existingServices.map((s) => s.name));

    logger.info({
      total: SERVICES.length,
      existing: existingNames.size,
      dryRun,
    }, 'Starting seed idempotency check');

    let registered = 0;
    let skipped = 0;

    for (const svc of SERVICES) {
      if (existingNames.has(svc.name)) {
        logger.info({ name: svc.name }, 'Service already registered — skipping');
        skipped++;
        continue;
      }

      if (dryRun) {
        logger.info({ name: svc.name, endpoint: svc.endpoint, category: svc.category, priceUsdc: svc.priceUsdc }, '[DRY RUN] Would register service');
        registered++;
        continue;
      }

      try {
        const id = await registerServiceOnChain(
          svc.name,
          svc.description,
          svc.endpoint,
          svc.priceUsdc,
          svc.category
        );
        logger.info({ id, name: svc.name }, 'Registered service');
        registered++;
      } catch (err) {
        logger.error({ err, name: svc.name }, 'Failed to register service');
      }
    }

    logger.info({ registered, skipped, dryRun }, 'Seed complete');
    if (dryRun) {
      logger.info('DRY RUN — no transactions were submitted. Re-run with --yes to execute.');
    }
  } catch (err) {
    logger.error({ err }, 'Seed script failed');
    process.exit(1);
  }
}

// CLI entry point — only when run directly (not imported)
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isYes = args.includes('--yes');

  printTargetInfo();

  if (!isDryRun && !isYes) {
    logger.error('Live run requires --yes confirmation. Use --dry-run to preview what will happen first.');
    process.exit(1);
  }

  seed({ dryRun: isDryRun }).then(() => process.exit(0));
}
