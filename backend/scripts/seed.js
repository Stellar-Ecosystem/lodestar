import 'dotenv/config';
import { getServiceCount, listServices, registerServiceOnChain } from '../src/lib/contract.js';
import logger from '../src/lib/logger.js';

process.env.SEEDING_MODE ??= 'true';

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

async function seed() {
  try {
    const count = await getServiceCount();
    logger.info({ count }, 'Current service count');

    // Compare by service name rather than total count: a count-only check skips
    // seeding after a partial failure (e.g. 2 of 4 registered), leaving the
    // missing services unregistered forever. Fetch existing names and only
    // register the ones that aren't on-chain yet.
    const existing = await listServices({ page: 0, pageSize: Math.max(count, SERVICES.length) });
    const existingNames = new Set(existing.map((s) => s.name));
    const missing = SERVICES.filter((svc) => !existingNames.has(svc.name));

    if (missing.length === 0) {
      logger.info('All seed services already registered — skipping');
      process.exit(0);
    }

    logger.info({ missing: missing.map((s) => s.name) }, 'Registering missing services');

    for (const svc of missing) {
      try {
        const id = await registerServiceOnChain(
          svc.name,
          svc.description,
          svc.endpoint,
          svc.priceUsdc,
          svc.category
        );
        logger.info({ id, name: svc.name }, 'Registered service');
      } catch (err) {
        logger.error({ err, name: svc.name }, 'Failed to register service');
      }
    }

    logger.info('Seed complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Seed script failed');
    process.exit(1);
  }
}

seed();
