import 'dotenv/config';

const required = [
  'CONTRACT_ID',
  'SERVER_STELLAR_ADDRESS',
  'SERVER_STELLAR_SECRET',
  'STELLAR_RPC_URL',
  'STELLAR_NETWORK_PASSPHRASE',
  'FACILITATOR_URL',
  'USDC_CONTRACT_ID',
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

/**
 * Parse a positive-integer env var, falling back to a safe default when the
 * value is missing, non-numeric, or non-positive. Logs a warning so a typo in
 * a rate-limit setting can't silently disable throttling (NaN/0 limits).
 */
function parsePositiveInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[config] Invalid ${name}="${value}" (expected a positive integer). Using fallback ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Parse the Express `trust proxy` setting from env. Accepts:
 *   - "true"/"false"        → boolean
 *   - a non-negative integer → number of trusted proxy hops
 *   - any other string       → passed through (IP/subnet list)
 * Defaults to false (no proxy trusted) — the safe choice that prevents clients
 * from spoofing X-Forwarded-For to bypass IP-based rate limiting.
 */
function parseTrustProxy(value) {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number(value);
  if (Number.isInteger(num) && num >= 0) return num;
  return value;
}

// Validate PAYMENT_ADDRESS format if explicitly provided (not relying on fallback)
if (process.env.PAYMENT_ADDRESS && !/^G[A-Z2-7]{55}$/.test(process.env.PAYMENT_ADDRESS)) {
  throw new Error(
    `Invalid PAYMENT_ADDRESS="${process.env.PAYMENT_ADDRESS}" — must be a valid G... Stellar address`,
  );
}

const config = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3001', 10),
  logLevel: process.env.LOG_LEVEL ?? 'info',

  stellar: {
    network: process.env.STELLAR_NETWORK ?? 'testnet',
    rpcUrl: process.env.STELLAR_RPC_URL,
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE,
    usdcContractId: process.env.USDC_CONTRACT_ID,
  },

  contract: {
    id: process.env.CONTRACT_ID,
    agentsId: process.env.AGENTS_CONTRACT_ID ?? null,
  },

  // Warn at startup if AGENTS_CONTRACT_ID is missing so operators spot it
  // before hitting 503 AGENTS_NOT_CONFIGURED in production.
  // The distinction: null means "agents contract not deployed yet" (expected for
  // plain service listings), whereas a malformed ID would cause on-chain failures.
  // If credit scoring is a requirement for your deployment, set this env var.
  _agentsConfigured: process.env.AGENTS_CONTRACT_ID !== undefined,

  server: {
    address: process.env.SERVER_STELLAR_ADDRESS,
    secret: process.env.SERVER_STELLAR_SECRET,
  },

  x402: {
    facilitatorUrl: process.env.FACILITATOR_URL,
    searchPrice: process.env.SEARCH_PRICE ?? '0.001',
    weatherPrice: process.env.WEATHER_PRICE ?? '0.001',
    payTo: process.env.PAYMENT_ADDRESS || process.env.SERVER_STELLAR_ADDRESS,
  },

  braveApiKey: process.env.BRAVE_API_KEY ?? '',

  corsOrigin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
    : ['http://localhost:3000'],

  jsonBodyLimit: process.env.JSON_BODY_LIMIT ?? '100kb',

  // Trust proxy setting for Express — required so rate limiting reads the real
  // client IP (X-Forwarded-For) when running behind a reverse proxy (e.g. Render).
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  // Reputation voting is gated on-chain: a vote must be signed by a registered
  // agent (`caller.require_auth()` + cross-contract `is_registered`). The hosted
  // backend can therefore only cast votes for agents whose secret keys it holds.
  // `voterSecrets` is that allowlist of demo-agent signing keys. The server key
  // always doubles as a demo voter; additional pre-funded, on-chain-registered
  // demo agents can be added via DEMO_VOTER_SECRETS (comma-separated). Any other
  // agent must submit its own wallet-signed transaction.
  demo: {
    voterSecrets: [
      process.env.SERVER_STELLAR_SECRET,
      ...(process.env.DEMO_VOTER_SECRETS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ],
  },

  // Rate limiting for public write endpoints (anti-spam for on-chain writes).
  rateLimit: {
    // Generic limit applied to write routes (POST /reputation/:id, POST /agents/register).
    windowMs: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000, 'RATE_LIMIT_WINDOW_MS'),
    max: parsePositiveInt(process.env.RATE_LIMIT_MAX, 20, 'RATE_LIMIT_MAX'),
    // Tighter, per-agent limit for the payment route.
    payment: {
      windowMs: parsePositiveInt(process.env.PAYMENT_RATE_LIMIT_WINDOW_MS, 60_000, 'PAYMENT_RATE_LIMIT_WINDOW_MS'),
      max: parsePositiveInt(process.env.PAYMENT_RATE_LIMIT_MAX, 10, 'PAYMENT_RATE_LIMIT_MAX'),
    },
  },

  demoRun: {
    pollMaxWaitMs: parsePositiveInt(process.env.DEMO_RUN_POLL_MAX_WAIT_MS, 8_000, 'DEMO_RUN_POLL_MAX_WAIT_MS'),
    pollInitialDelayMs: parsePositiveInt(process.env.DEMO_RUN_POLL_INITIAL_DELAY_MS, 250, 'DEMO_RUN_POLL_INITIAL_DELAY_MS'),
    pollMaxDelayMs: parsePositiveInt(process.env.DEMO_RUN_POLL_MAX_DELAY_MS, 2_000, 'DEMO_RUN_POLL_MAX_DELAY_MS'),
  },

  // Graceful shutdown: how long (ms) to wait for the submit queue to drain
  // and pending transaction checks before force-exiting. Default is just over
  // the max polling window (30 s) so an in-flight poll can finish.
  shutdownTimeoutMs: parsePositiveInt(process.env.SHUTDOWN_TIMEOUT_MS, 35_000, 'SHUTDOWN_TIMEOUT_MS'),
});

export default config;

// Warn at startup if AGENTS_CONTRACT_ID is absent.
// Null agentsId means credit scoring is unavailable — operators should set the
// env var if they rely on agent credit scoring.
if (!process.env.AGENTS_CONTRACT_ID) {
  console.warn(
    '[config] AGENTS_CONTRACT_ID is not set. Agent credit scoring will return 503 AGENTS_NOT_CONFIGURED. ' +
    'Set AGENTS_CONTRACT_ID in your environment if credit scoring is required.',
  );
}
