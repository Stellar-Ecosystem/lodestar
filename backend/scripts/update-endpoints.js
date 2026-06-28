import 'dotenv/config';
import { fileURLToPath } from 'url';
import { listServices, registerServiceOnChain } from '../src/lib/contract.js';
import logger from '../src/lib/logger.js';

process.env.SEEDING_MODE ??= 'true';

const BACKEND_URL = process.env.BACKEND_URL;

if (!BACKEND_URL) {
  logger.error('BACKEND_URL not set — provide the deployed backend base URL');
  process.exit(1);
}

export async function update() {
  try {
    const weather = await listServices({ category: 'weather' });
    const search = await listServices({ category: 'search' });
    const all = [...weather, ...search];

    const needsUpdate = all.filter((s) => s.endpoint.includes('localhost'));

    if (!needsUpdate.length) {
      logger.info('All endpoints already point to the deployed host — nothing to do');
      process.exit(0);
      return;
    }

    for (const svc of needsUpdate) {
      const newEndpoint = svc.endpoint.replace(/https?:\/\/localhost:\d+/, BACKEND_URL);
      logger.info({ name: svc.name, newEndpoint }, 'Re-registering with deployed URL…');

      const newId = await registerServiceOnChain(
        svc.name,
        svc.description,
        newEndpoint,
        svc.price_usdc,
        svc.category
      );
      logger.info({ name: svc.name, newId }, 'Done');
    }

    logger.info('All endpoints updated. New services registered with deployed URLs.');
    process.exit(0);
    return;
  } catch (err) {
    logger.error({ err }, 'update-endpoints failed');
    process.exit(1);
    return;
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) update();
